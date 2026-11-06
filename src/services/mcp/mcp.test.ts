import { describe, expect, it, vi } from 'vitest';

vi.mock('../tauriBridge', () => ({ tauriBridge: {} }));

import type { AppSettings } from '../../types/agent';
import type { AgentCallbacks } from '../agent/types';
import { executeTool } from '../agent/tools';
import { McpClient, parseSseMessages, type McpTransport } from './client';
import { parseMcpConfig, readMcpEntries, serverKey, withMcpEntryDisabled, withMcpToolsDisabled } from './config';
import { McpManager, formatToolResult, mcpToolName, sanitizeSchema, type McpServerStatus, type McpToolInfo } from './manager';
import { TOOL_COUNT_WARN_AT, TOOL_TOKENS_WARN_AT, estimateToolTokens, summarizeToolUsage } from './toolUsage';

/** server ปลอมในหน่วยความจำ: ตอบ initialize / tools/list / tools/call */
function fakeServer(tools: any[], onCall?: (name: string, args: any) => any): McpTransport & { sent: any[] } {
  const transport: McpTransport & { sent: any[] } = {
    sent: [],
    async send(msg: any) {
      transport.sent.push(msg);
      if (msg.id === undefined || !msg.method) return;
      const reply = (result: unknown) => queueMicrotask(() => transport.onMessage?.({ jsonrpc: '2.0', id: msg.id, result }));
      if (msg.method === 'initialize') reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'fake' }, capabilities: { tools: {} } });
      else if (msg.method === 'tools/list') reply({ tools });
      else if (msg.method === 'tools/call') reply(onCall?.(msg.params.name, msg.params.arguments) ?? { content: [] });
    },
    async close() {},
  };
  return transport;
}

describe('parseMcpConfig', () => {
  it('reads stdio and http servers in the Claude Desktop format', () => {
    const { servers, errors } = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          'my files': { command: 'npx', args: ['-y', 'server-fs', 1], env: { DEBUG: 1 } },
          remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
          off: { command: 'x', disabled: true },
          legacy: { type: 'sse', url: 'https://old' },
          broken: { args: [] },
        },
      })
    );
    expect(servers.map((s) => [s.key, s.transport])).toEqual([
      ['my_files', 'stdio'],
      ['remote', 'http'],
    ]);
    expect(servers[0]).toMatchObject({ command: 'npx', args: ['-y', 'server-fs', '1'], env: { DEBUG: '1' } });
    expect(errors).toHaveLength(2);
    expect(parseMcpConfig('{ nope').errors[0]).toMatch(/^JSON/);
    expect(parseMcpConfig('')).toEqual({ servers: [], errors: [] });
  });

  it('makes tool-safe server keys without double underscores', () => {
    expect(serverKey('GitHub (work)')).toBe('GitHub_work');
    expect(serverKey('a__b')).toBe('a_b');
    expect(serverKey('!!!')).toBe('server');
  });
});

describe('McpClient', () => {
  it('initializes, pages through tools/list and answers pings', async () => {
    const transport = fakeServer([]);
    let page = 0;
    const send = transport.send.bind(transport);
    transport.send = async (msg: any) => {
      if (msg.method === 'tools/list') {
        transport.sent.push(msg);
        const result = page++ === 0 ? { tools: [{ name: 'a' }], nextCursor: 'p2' } : { tools: [{ name: 'b' }] };
        queueMicrotask(() => transport.onMessage?.({ jsonrpc: '2.0', id: msg.id, result }));
        return;
      }
      return send(msg);
    };
    const client = new McpClient(transport);
    await client.initialize();
    expect(transport.sent.map((m) => m.method)).toEqual(['initialize', 'notifications/initialized']);
    expect((await client.listTools()).map((t) => t.name)).toEqual(['a', 'b']);
    expect(transport.sent.at(-1).params).toEqual({ cursor: 'p2' });

    transport.onMessage?.({ jsonrpc: '2.0', id: 99, method: 'ping' });
    await Promise.resolve();
    expect(transport.sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 99, result: {} });
  });

  it('rejects on JSON-RPC errors, timeouts and closed connections', async () => {
    vi.useFakeTimers();
    const transport: McpTransport = { send: async () => {}, close: async () => {} };
    const client = new McpClient(transport, 1000);
    const timedOut = expect(client.request('slow')).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1000);
    await timedOut;

    const pending = client.request('x');
    transport.onMessage?.({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'bad params' } });
    await expect(pending).rejects.toThrow('bad params');

    const dropped = client.request('y');
    transport.onClose?.('Server process exited (code 1)');
    await expect(dropped).rejects.toThrow(/exited/);
    vi.useRealTimers();
  });

  it('stops waiting and tells the server when the request is cancelled', async () => {
    const sent: any[] = [];
    const transport: McpTransport = { send: async (m) => void sent.push(m), close: async () => {} };
    const client = new McpClient(transport);
    const controller = new AbortController();
    const call = client.callTool('build', {}, 300_000, controller.signal);
    controller.abort();
    await expect(call).rejects.toThrow(/cancelled/);
    expect(sent.at(-1)).toMatchObject({ method: 'notifications/cancelled', params: { requestId: sent[0].id } });

    // คำตอบที่มาช้าหลังยกเลิกถูกทิ้ง และ signal ที่ยกเลิกไปแล้วไม่ส่ง request เลย
    transport.onMessage?.({ jsonrpc: '2.0', id: sent[0].id, result: {} });
    await expect(client.callTool('build', {}, 1000, controller.signal)).rejects.toThrow(/cancelled/);
    expect(sent).toHaveLength(2);
  });

  it('parses SSE bodies from Streamable HTTP', () => {
    expect(parseSseMessages('event: message\ndata: {"id":1}\n\ndata: {"id":\ndata: 2}\n\n')).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

describe('McpManager', () => {
  const tools = [
    { name: 'search.issues', description: 'Find issues', inputSchema: { $schema: 'x', type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    { name: 'create_issue', inputSchema: {} },
  ];

  it('exposes prefixed tools of ready servers and routes calls back', async () => {
    const calls: any[] = [];
    const manager = new McpManager(() =>
      fakeServer(tools, (name, args) => {
        calls.push([name, args]);
        return { content: [{ type: 'text', text: 'found 3' }] };
      })
    );
    manager.sync(parseMcpConfig(JSON.stringify({ mcpServers: { gh: { type: 'http', url: 'https://x' } } })).servers, 'D:\\proj');
    expect(manager.statuses()[0].state).toBe('starting');
    await vi.waitFor(() => expect(manager.statuses()[0].state).toBe('ready'));

    const defs = manager.toolDefinitions();
    expect(defs.map((d) => d.name)).toEqual(['mcp__gh__search_issues', 'mcp__gh__create_issue']);
    expect(defs[0].parameters).toEqual({ type: 'object', properties: { q: { type: 'string' } } });
    expect(manager.isReadOnly('mcp__gh__search_issues')).toBe(true);
    expect(manager.isReadOnly('mcp__gh__create_issue')).toBe(false);
    expect(await manager.callTool('mcp__gh__search_issues', { q: 'bug' })).toEqual({ text: 'found 3', isError: false });
    expect(calls).toEqual([['search.issues', { q: 'bug' }]]);

    manager.sync([], 'D:\\proj');
    expect(manager.toolDefinitions()).toEqual([]);
  });

  it('reports a failed server instead of throwing', async () => {
    const manager = new McpManager(() => ({ send: async () => Promise.reject(new Error('connection refused')), close: async () => {} }));
    manager.sync(parseMcpConfig('{"mcpServers":{"down":{"type":"http","url":"https://x"}}}').servers, '');
    await vi.waitFor(() => expect(manager.statuses()[0]).toMatchObject({ state: 'error', error: 'connection refused' }));
  });
});

describe('MCP helpers', () => {
  it('keeps tool names within 64 safe characters', () => {
    expect(mcpToolName('srv', 'a.b c')).toBe('mcp__srv__a_b_c');
    expect(mcpToolName('srv', 'x'.repeat(100))).toHaveLength(64);
  });

  it('turns any schema into an object schema', () => {
    expect(sanitizeSchema(undefined)).toEqual({ type: 'object', properties: {} });
    expect(sanitizeSchema({ type: 'string' })).toEqual({ type: 'object', properties: {} });
    expect(sanitizeSchema({ properties: { a: {} }, required: ['a'] })).toEqual({ type: 'object', properties: { a: {} }, required: ['a'] });
  });

  it('formats mixed content for the model', () => {
    expect(
      formatToolResult({
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', mimeType: 'image/png', data: 'AAA' },
          { type: 'resource', resource: { uri: 'file:///a', text: 'body' } },
          { type: 'resource_link', uri: 'file:///b', name: 'b' },
        ],
      })
    ).toBe('hi\n[image image/png omitted]\nbody\n[resource file:///b (b)]');
    expect(formatToolResult({ content: [], structuredContent: { n: 1 } })).toBe('{"n":1}');
  });
});

describe('MCP tool permissions', () => {
  const callbacks = (decision: 'once' | 'reject', asked: string[]): AgentCallbacks => ({
    onTextChunk: () => {},
    onToolStart: () => {},
    onToolUpdate: () => {},
    onRequestApproval: async (tool) => {
      asked.push(tool.approvalReason ?? '');
      return decision;
    },
  });
  const mcp = {
    isDisabled: (name: string) => name.endsWith('off'),
    isReadOnly: (name: string) => name.endsWith('search'),
    callTool: vi.fn(async () => ({ text: 'ok', isError: false })),
  };
  const settings = (autoPilot: boolean) => ({ cwd: 'D:\\proj', autoPilot, permissionRules: [] }) as unknown as AppSettings;

  it('asks before calling, except read-only tools in Auto-Pilot', async () => {
    const asked: string[] = [];
    await executeTool('mcp__gh__search', {}, settings(true), callbacks('once', asked), undefined, { mcp });
    expect(asked).toEqual([]);
    await executeTool('mcp__gh__search', {}, settings(false), callbacks('once', asked), undefined, { mcp });
    expect(asked).toEqual(['mcp_tool']);
    const res = await executeTool('mcp__gh__create', { title: 'x' }, settings(true), callbacks('reject', asked), undefined, { mcp });
    expect(res).toMatchObject({ error: expect.stringMatching(/rejected/i) });
    expect(mcp.callTool).toHaveBeenCalledTimes(2);
  });

  it('honours allow and deny rules on tool names', async () => {
    const asked: string[] = [];
    const rules = [
      { id: '1', action: 'allow' as const, tool: 'mcp' as const, pattern: 'mcp__gh__*' },
      { id: '2', action: 'deny' as const, tool: 'mcp' as const, pattern: 'mcp__gh__delete*' },
    ];
    const store = { rules: () => rules, addRule: () => {} };
    expect(await executeTool('mcp__gh__create', {}, settings(false), callbacks('reject', asked), store, { mcp })).toEqual({ content: 'ok' });
    expect(await executeTool('mcp__gh__delete_repo', {}, settings(false), callbacks('once', asked), store, { mcp })).toMatchObject({
      error: expect.stringContaining('mcp__gh__delete*'),
    });
    expect(asked).toEqual([]);
  });

  it("passes the turn's abort signal to the server call", async () => {
    const signal = new AbortController().signal;
    await executeTool('mcp__gh__search', { q: 'x' }, settings(true), callbacks('once', []), undefined, { mcp, signal });
    expect(mcp.callTool).toHaveBeenLastCalledWith('mcp__gh__search', { q: 'x' }, signal);
  });

  it('refuses a disabled tool without asking, even with an allow rule', async () => {
    const asked: string[] = [];
    const calls = mcp.callTool.mock.calls.length;
    const rules = [{ id: '1', action: 'allow' as const, tool: 'mcp' as const, pattern: 'mcp__gh__*' }];
    const store = { rules: () => rules, addRule: () => {} };
    for (const autoPilot of [true, false]) {
      expect(await executeTool('mcp__gh__off', {}, settings(autoPilot), callbacks('once', asked), store, { mcp })).toMatchObject({
        error: expect.stringContaining('turned off'),
      });
    }
    expect(asked).toEqual([]);
    expect(mcp.callTool).toHaveBeenCalledTimes(calls);
  });
});

describe('disabledTools in the config', () => {
  const config = (server: Record<string, unknown>) => JSON.stringify({ mcpServers: { gh: { type: 'http', url: 'https://x', ...server } } });

  it('reads the list for both transports and leaves it out when empty', () => {
    expect(parseMcpConfig(config({ disabledTools: ['a', 'b'] })).servers[0].disabledTools).toEqual(['a', 'b']);
    expect(parseMcpConfig(config({ disabledTools: [] })).servers[0]).not.toHaveProperty('disabledTools');
    expect(parseMcpConfig(config({})).servers[0]).not.toHaveProperty('disabledTools');
    const stdio = JSON.stringify({ mcpServers: { fs: { command: 'node', disabledTools: ['write'] } } });
    expect(parseMcpConfig(stdio).servers[0].disabledTools).toEqual(['write']);
  });

  it('skips the server when the list cannot be read, so a tool meant to be off never turns on by accident', () => {
    for (const bad of ['write', ['write', 1], { write: true }, null]) {
      const { servers, errors } = parseMcpConfig(config({ disabledTools: bad }));
      expect(servers).toEqual([]);
      expect(errors[0]).toContain('disabledTools');
    }
  });

  it('adds and removes tools while keeping everything else in the entry', () => {
    const start = JSON.stringify({ mcpServers: { gh: { type: 'http', url: 'https://x', disabled: true } }, other: 1 });
    const off = withMcpToolsDisabled(start, 'gh', ['a', 'b'], true);
    expect(readMcpEntries(off)!.gh).toEqual({ type: 'http', url: 'https://x', disabled: true, disabledTools: ['a', 'b'] });
    expect(JSON.parse(off).other).toBe(1);
    // ซ้ำไม่เพิ่ม และเปิดกลับเฉพาะตัวที่ระบุ
    expect(readMcpEntries(withMcpToolsDisabled(off, 'gh', ['a'], true))!.gh.disabledTools).toEqual(['a', 'b']);
    expect(readMcpEntries(withMcpToolsDisabled(off, 'gh', ['a'], false))!.gh.disabledTools).toEqual(['b']);
    expect(readMcpEntries(withMcpToolsDisabled(off, 'gh', ['a', 'b'], false))!.gh).not.toHaveProperty('disabledTools');
  });

  it('keeps the list when the whole server is turned off and on', () => {
    const off = withMcpToolsDisabled(config({}), 'gh', ['a'], true);
    expect(readMcpEntries(withMcpEntryDisabled(withMcpEntryDisabled(off, 'gh', true), 'gh', false))!.gh.disabledTools).toEqual(['a']);
  });

  it('ignores servers that do not exist and refuses a broken config', () => {
    expect(readMcpEntries(withMcpToolsDisabled(config({}), 'nope', ['a'], true))).not.toHaveProperty('nope');
    expect(() => withMcpToolsDisabled('{ broken', 'gh', ['a'], true)).toThrow();
  });
});

describe('McpManager with disabled tools', () => {
  const tools = [
    { name: 'search', description: 'Find things', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    { name: 'delete', description: 'Delete things', inputSchema: {} },
  ];
  const servers = (disabledTools?: string[]) =>
    parseMcpConfig(JSON.stringify({ mcpServers: { gh: { type: 'http', url: 'https://x', ...(disabledTools ? { disabledTools } : {}) } } })).servers;

  async function connected(disabledTools?: string[], list: any[] = tools, onCall?: (name: string, args: any) => any) {
    const transports: ReturnType<typeof fakeServer>[] = [];
    const manager = new McpManager(() => {
      const transport = fakeServer(list, onCall);
      transports.push(transport);
      return transport;
    });
    manager.sync(servers(disabledTools), '');
    await vi.waitFor(() => expect(manager.statuses()[0].state).toBe('ready'));
    return { manager, transports };
  }

  it('does not offer a disabled tool to the model', async () => {
    const { manager } = await connected(['delete']);
    expect(manager.toolDefinitions().map((d) => d.name)).toEqual(['mcp__gh__search']);
    expect(manager.statuses()[0].tools).toEqual(['search']);
  });

  it('still lists it for the page, with its size', async () => {
    const { manager } = await connected(['delete']);
    const info = manager.statuses()[0].toolInfo;
    expect(info.map((t) => [t.name, t.enabled])).toEqual([
      ['search', true],
      ['delete', false],
    ]);
    expect(info[0].description).toBe('Find things');
    expect(info[0].tokens).toBeGreaterThan(info[1].tokens);
  });

  it('refuses to call a disabled tool and never reaches the server', async () => {
    const calls: string[] = [];
    const { manager } = await connected(['delete'], tools, (name) => {
      calls.push(name);
      return { content: [] };
    });
    expect(manager.isDisabled('mcp__gh__delete')).toBe(true);
    expect(manager.isDisabled('mcp__gh__search')).toBe(false);
    expect(manager.isDisabled('mcp__gh__unknown')).toBe(false);
    expect(manager.isReadOnly('mcp__gh__delete')).toBe(false);
    await expect(manager.callTool('mcp__gh__delete', {})).rejects.toThrow(/not available/);
    expect(calls).toEqual([]);
  });

  it('does not treat a declared read-only tool as allowed once it is disabled', async () => {
    const { manager } = await connected(['search']);
    expect(manager.isReadOnly('mcp__gh__search')).toBe(false);
    expect(manager.isDisabled('mcp__gh__search')).toBe(true);
  });

  it('applies a change right away without reconnecting', async () => {
    const { manager, transports } = await connected();
    const seen = vi.fn();
    manager.subscribe(seen);
    manager.sync(servers(['delete']), '');
    expect(manager.toolDefinitions().map((d) => d.name)).toEqual(['mcp__gh__search']);
    expect(manager.statuses()[0].toolInfo[1].enabled).toBe(false);
    expect(seen).toHaveBeenCalled();
    manager.sync(servers(), '');
    expect(manager.toolDefinitions()).toHaveLength(2);
    expect(transports).toHaveLength(1);
  });

  it('reconnects when the connection itself changes, and keeps the list', async () => {
    const { manager, transports } = await connected(['delete']);
    const moved = parseMcpConfig(JSON.stringify({ mcpServers: { gh: { type: 'http', url: 'https://y', disabledTools: ['delete'] } } })).servers;
    manager.sync(moved, '');
    await vi.waitFor(() => expect(manager.statuses()[0].state).toBe('ready'));
    expect(transports).toHaveLength(2);
    expect(manager.toolDefinitions().map((d) => d.name)).toEqual(['mcp__gh__search']);
  });

  it('keeps tools off after the server refreshes its list, and turns on tools it adds later', async () => {
    const { manager, transports } = await connected(['delete']);
    const send = transports[0].send;
    transports[0].send = async (msg: any) => {
      if (msg.method !== 'tools/list') return send(msg);
      queueMicrotask(() => transports[0].onMessage?.({ jsonrpc: '2.0', id: msg.id, result: { tools: [...tools, { name: 'brand_new' }] } }));
    };
    transports[0].onMessage?.({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    await vi.waitFor(() => expect(manager.statuses()[0].toolInfo).toHaveLength(3));
    expect(manager.toolDefinitions().map((d) => d.name)).toEqual(['mcp__gh__search', 'mcp__gh__brand_new']);
  });

  it('does not let a disabled tool hide an enabled one with the same safe name', async () => {
    const calls: string[] = [];
    const { manager } = await connected(['a.b'], [{ name: 'a.b' }, { name: 'a_b' }], (name) => {
      calls.push(name);
      return { content: [] };
    });
    expect(manager.isDisabled('mcp__gh__a_b')).toBe(false);
    await manager.callTool('mcp__gh__a_b', {});
    expect(calls).toEqual(['a_b']);
  });
});

describe('summarizeToolUsage', () => {
  const builtIn = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } }];
  const status = (toolInfo: McpToolInfo[], state: McpServerStatus['state'] = 'ready'): McpServerStatus => ({
    name: 's',
    key: 's',
    transport: 'http',
    state,
    tools: [],
    toolInfo,
  });
  const tool = (tokens: number, enabled = true): McpToolInfo => ({ name: `t${tokens}`, description: '', enabled, tokens });

  it('counts only tools that will really be sent', () => {
    const usage = summarizeToolUsage([status([tool(100), tool(50, false)]), status([tool(9000)], 'error')], builtIn);
    expect(usage).toMatchObject({ mcpTools: 1, mcpTokens: 100, builtInTools: 1, totalTools: 2, isHigh: false });
    expect(usage.totalTokens).toBe(100 + usage.builtInTokens);
  });

  it('warns once the plugins are heavy or there are too many tools, but never about built-ins alone', () => {
    expect(summarizeToolUsage([status([tool(TOOL_TOKENS_WARN_AT - 1)])], builtIn).isHigh).toBe(false);
    expect(summarizeToolUsage([status([tool(TOOL_TOKENS_WARN_AT)])], builtIn).isHigh).toBe(true);
    const many = Array.from({ length: TOOL_COUNT_WARN_AT }, (_, i) => ({ ...tool(1), name: `t${i}` }));
    expect(summarizeToolUsage([status(many)], builtIn).isHigh).toBe(true);
    expect(summarizeToolUsage([status(many.slice(1))], builtIn).isHigh).toBe(false);
    expect(summarizeToolUsage([], Array.from({ length: 100 }, () => builtIn[0])).isHigh).toBe(false);
  });

  it('estimates from the JSON size and counts Thai text as heavier', () => {
    const ascii = estimateToolTokens({ name: 'a', description: 'x'.repeat(350), parameters: {} });
    expect(ascii).toBeGreaterThan(100);
    expect(ascii).toBeLessThan(125);
    expect(estimateToolTokens({ name: 'a', description: 'ก'.repeat(350), parameters: {} })).toBeGreaterThan(350);
  });
});
