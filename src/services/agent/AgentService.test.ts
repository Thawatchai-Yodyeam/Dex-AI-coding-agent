import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../types/agent';

const bridge = vi.hoisted(() => ({ readFile: vi.fn(), listDir: vi.fn(async () => []) }));
vi.mock('../tauriBridge', () => ({ tauriBridge: bridge }));

import type { McpTransport } from '../mcp/client';
import { parseMcpConfig } from '../mcp/config';
import { McpManager } from '../mcp/manager';
import { summarizeToolUsage } from '../mcp/toolUsage';
import { MultiProviderAgentService, STEPS_PER_CONFIRM } from './AgentService';
import { TOOL_DEFINITIONS } from './tools';
import { AgentAbortError } from './types';
import type { AgentCallbacks } from './types';

const settings = (patch: Partial<AppSettings> = {}) =>
  ({ cwd: 'D:\\proj', provider: 'deepseek', model: 'deepseek-flash', language: 'en', apiKeys: { deepseek: 'k' }, ...patch }) as AppSettings;

describe('loadProjectInstructions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the first instruction file that exists and is not blank', async () => {
    bridge.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('DEX.md')) throw new Error('not found');
      if (path.endsWith('AGENTS.md')) return 'Run npm test.';
      return 'claude';
    });
    const agent = new MultiProviderAgentService(settings());
    expect(await agent.loadProjectInstructions()).toEqual({ file: 'AGENTS.md', content: 'Run npm test.' });
    expect(bridge.readFile).toHaveBeenCalledWith('D:\\proj/DEX.md', 'D:\\proj');
  });

  it('returns null without a workspace or any file', async () => {
    bridge.readFile.mockRejectedValue(new Error('not found'));
    expect(await new MultiProviderAgentService(settings({ cwd: '' })).loadProjectInstructions()).toBeNull();
    expect(await new MultiProviderAgentService(settings()).loadProjectInstructions()).toBeNull();
  });

  it('truncates very long files', async () => {
    bridge.readFile.mockResolvedValue('x'.repeat(30_000));
    const res = await new MultiProviderAgentService(settings()).loadProjectInstructions();
    expect(res!.content.length).toBeLessThan(21_000);
    expect(res!.content).toContain('[... truncated ...]');
  });
});

describe('sendMessage with images', () => {
  it('rejects images for providers without vision before calling the API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const agent = new MultiProviderAgentService(settings());
    await expect(
      agent.sendMessage(
        { text: 'see', images: [{ id: 'i', name: 'a.png', mediaType: 'image/png', data: 'QQ==' }] },
        { onTextChunk: () => {}, onToolStart: () => {}, onToolUpdate: () => {}, onRequestApproval: async () => 'once' }
      )
    ).rejects.toThrow(/does not accept images/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

/** SSE ของ Chat Completions ที่ขอเรียก list_directory ทุกครั้ง — ให้ tool loop วนไม่จบ */
function toolCallResponse() {
  const chunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: `c${Math.random()}`, function: { name: 'list_directory', arguments: '{}' } }] } }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200 });
}

describe('native history persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridge.readFile.mockRejectedValue(new Error('not found'));
  });

  it('restores an exported history only if nothing changed since loading started', () => {
    const agent = new MultiProviderAgentService(settings());
    const snapshot = JSON.stringify({
      v: 1,
      format: 'openai',
      history: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'body' },
        { role: 'assistant', content: 'done' },
      ],
      sessionRules: [{ id: 'r', action: 'allow', tool: 'shell', pattern: 'npm test*' }],
    });

    agent.setHistory([{ role: 'user', content: 'hi' }]);
    const stale = agent.historyVersion;
    agent.clearHistory();
    expect(agent.restoreHistory(snapshot, stale)).toBe(false);

    expect(agent.restoreHistory('not json', agent.historyVersion)).toBe(false);
    expect(agent.restoreHistory(JSON.stringify({ v: 2, format: 'openai', history: [] }), agent.historyVersion)).toBe(false);
    expect(agent.restoreHistory(snapshot, agent.historyVersion)).toBe(true);
    expect(JSON.parse(agent.exportHistory()!)).toEqual(JSON.parse(snapshot));
  });

  it('exports nothing for an empty chat', () => {
    expect(new MultiProviderAgentService(settings()).exportHistory()).toBeNull();
  });
});

describe('step limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridge.readFile.mockRejectedValue(new Error('not found'));
  });

  it(`asks after ${STEPS_PER_CONFIRM} steps and closes the turn cleanly when told to stop`, async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => toolCallResponse());
    const asked: string[] = [];
    const callbacks: AgentCallbacks = {
      onTextChunk: () => {},
      onToolStart: () => {},
      onToolUpdate: () => {},
      onRequestApproval: async (tool) => {
        asked.push(tool.name);
        return 'reject';
      },
    };
    const agent = new MultiProviderAgentService(settings({ provider: 'openai', model: 'gpt-6.1-sol', apiKeys: { openai: 'k' } as any }));
    const res = await agent.sendMessage({ text: 'loop forever' }, callbacks);

    expect(asked).toEqual(['continue_turn']);
    expect(fetchSpy).toHaveBeenCalledTimes(STEPS_PER_CONFIRM);
    expect(res.text).toContain(`${STEPS_PER_CONFIRM} steps`);
    // ประวัติจบด้วย assistant — เทิร์นถัดไปส่งต่อได้โดยไม่มี tool call ค้าง
    const history = JSON.parse(agent.exportHistory()!).history;
    expect(history[history.length - 1]).toMatchObject({ role: 'assistant' });
    expect(history[history.length - 2]).toMatchObject({ role: 'tool' });
    fetchSpy.mockRestore();
  });
});

describe('context compaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridge.readFile.mockRejectedValue(new Error('not found'));
  });

  const textResponse = (text: string, tokens: number) =>
    new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: tokens, completion_tokens: 1, total_tokens: tokens + 1 } })}\n\n` +
        'data: [DONE]\n\n',
      { status: 200 }
    );
  // ~350k ตัวอักษร: เกินเกณฑ์สรุป (320k) แต่ยังไม่ถึงงบที่เริ่มล้างผล tool
  const bigHistory = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'a'.repeat(200_000) },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'b'.repeat(100_000) },
    { role: 'user', content: 'third' },
    { role: 'assistant', content: 'c'.repeat(50_000) },
  ];
  const openaiSettings = () => settings({ provider: 'openai', model: 'gpt-6.1-sol', apiKeys: { openai: 'k' } as any });
  const callbacks = (phases: string[]): AgentCallbacks => ({
    onTextChunk: () => {},
    onToolStart: () => {},
    onToolUpdate: () => {},
    onRequestApproval: async () => 'once',
    onCompaction: (phase) => phases.push(phase),
  });

  it('summarizes old turns before answering when the history is nearly full', async () => {
    const bodies: any[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      return bodies.length === 1 ? textResponse('- goal: ship it', 100) : textResponse('done', 20);
    });
    const agent = new MultiProviderAgentService(openaiSettings());
    agent.restoreHistory(JSON.stringify({ v: 1, format: 'openai', history: bigHistory }), agent.historyVersion);
    const phases: string[] = [];
    const res = await agent.sendMessage({ text: 'go on' }, callbacks(phases));

    expect(phases).toEqual(['start', 'done']);
    expect(bodies[0].tools).toBeUndefined();
    expect(bodies[0].reasoning_effort).toBe('none');
    const sent = bodies[1].messages.map((m: any) => m.content);
    expect(sent[1]).toContain('- goal: ship it');
    expect(sent.slice(3)).toEqual(['second', 'b'.repeat(100_000), 'third', 'c'.repeat(50_000), 'go on']);
    // token ของการสรุปนับรวมในเทิร์นนี้
    expect(res.tokenUsage.promptTokens).toBe(120);
    expect(JSON.parse(agent.exportHistory()!).history[0].content).toContain('<conversation_summary>');
    fetchSpy.mockRestore();
  });

  it('carries on with plain trimming when the summary request fails', async () => {
    let calls = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      ++calls === 1 ? new Response('{"error":{"message":"bad"}}', { status: 400 }) : textResponse('done', 20)
    );
    const agent = new MultiProviderAgentService(openaiSettings());
    agent.restoreHistory(JSON.stringify({ v: 1, format: 'openai', history: bigHistory }), agent.historyVersion);
    const phases: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await agent.sendMessage({ text: 'go on' }, callbacks(phases));

    expect(phases).toEqual(['start', 'skipped']);
    expect(res.text).toBe('done');
    expect(JSON.parse(agent.exportHistory()!).history[0]).toEqual({ role: 'user', content: 'first' });
    fetchSpy.mockRestore();
    warn.mockRestore();
  });

  it('stops without answering when the user aborts during the summary', async () => {
    const controller = new AbortController();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    const agent = new MultiProviderAgentService(openaiSettings());
    agent.restoreHistory(JSON.stringify({ v: 1, format: 'openai', history: bigHistory }), agent.historyVersion);
    await expect(agent.sendMessage({ text: 'go on' }, callbacks([]), controller.signal)).rejects.toBeInstanceOf(AgentAbortError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // ข้อความผู้ใช้ยังถูกจำไว้แบบ text-only เหมือนกดหยุดตอนอื่น
    expect(JSON.parse(agent.exportHistory()!).history.at(-2)).toEqual({ role: 'user', content: 'go on' });
    fetchSpy.mockRestore();
  });
});

/** SSE ของ Claude: thinking + ข้อความ หรือ thinking + เรียก tool */
function claudeResponse(reply: { text?: string; tool?: string }) {
  const events: unknown[] = [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'because', signature: 'sig' } },
    reply.tool
      ? { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: reply.tool } }
      : { type: 'content_block_start', index: 1, content_block: { type: 'text', text: reply.text ?? 'done' } },
    { type: 'message_delta', delta: { stop_reason: reply.tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } },
  ];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });
}

describe('disabled MCP tools reach no provider', () => {
  const noCallbacks = (asked: string[] = []): AgentCallbacks => ({
    onTextChunk: () => {},
    onToolStart: () => {},
    onToolUpdate: () => {},
    onRequestApproval: async (tool) => {
      asked.push(tool.name);
      return 'once';
    },
  });
  const serverTools = [
    { name: 'search', description: 'Find', inputSchema: { type: 'object', properties: {} } },
    { name: 'delete_repo', description: 'Delete', inputSchema: { type: 'object', properties: {} } },
  ];
  const mcpConfig = (disabledTools: string[]) =>
    JSON.stringify({ mcpServers: { gh: { type: 'http', url: 'https://x', ...(disabledTools.length ? { disabledTools } : {}) } } });

  /** server ปลอมในหน่วยความจำแบบเดียวกับ mcp.test.ts */
  function fakeTransport(onCall: (name: string) => void, tools: unknown[] = serverTools): McpTransport {
    const transport: McpTransport = {
      async send(msg: any) {
        if (msg.id === undefined || !msg.method) return;
        const reply = (result: unknown) => queueMicrotask(() => transport.onMessage?.({ jsonrpc: '2.0', id: msg.id, result }));
        if (msg.method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} } });
        else if (msg.method === 'tools/list') reply({ tools });
        else if (msg.method === 'tools/call') {
          onCall(msg.params.name);
          reply({ content: [{ type: 'text', text: 'ran' }] });
        }
      },
      async close() {},
    };
    return transport;
  }

  async function agentWith(
    patch: Partial<AppSettings>,
    disabled: string[] = ['delete_repo'],
    onCall: (name: string) => void = () => {},
    tools: unknown[] = serverTools
  ) {
    const manager = new McpManager(() => fakeTransport(onCall, tools));
    manager.sync(parseMcpConfig(mcpConfig(disabled)).servers, '');
    await vi.waitFor(() => expect(manager.statuses()[0].state).toBe('ready'));
    const agent = new MultiProviderAgentService(settings(patch));
    agent.setMcpProvider(manager);
    return { agent, manager };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    bridge.readFile.mockRejectedValue(new Error('not found'));
  });

  const openai = { provider: 'openai', model: 'gpt-6.1-sol', apiKeys: { openai: 'k' } } as Partial<AppSettings>;
  const anthropic = { provider: 'anthropic', model: 'claude-opus-5-5', apiKeys: { anthropic: 'k' } } as Partial<AppSettings>;
  const google = { provider: 'google', model: 'gemini-3.8-flash', apiKeys: { google: 'k' } } as Partial<AppSettings>;
  const textReply = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });

  it('leaves them out of an OpenAI-style request', async () => {
    const bodies: any[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      return textReply();
    });
    const { agent } = await agentWith(openai);
    await agent.sendMessage({ text: 'hi' }, noCallbacks());
    const names = bodies[0].tools.map((t: any) => t.function.name);
    expect(names).toContain('mcp__gh__search');
    expect(names).not.toContain('mcp__gh__delete_repo');
    expect(JSON.stringify(bodies[0])).not.toContain('delete_repo');
    fetchSpy.mockRestore();
  });

  it('leaves them out of a Claude request', async () => {
    const bodies: any[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      return claudeResponse({ text: 'done' });
    });
    const { agent } = await agentWith(anthropic);
    await agent.sendMessage({ text: 'hi' }, noCallbacks());
    const names = bodies[0].tools.map((t: any) => t.name);
    expect(names).toContain('mcp__gh__search');
    expect(JSON.stringify(bodies[0])).not.toContain('delete_repo');
    fetchSpy.mockRestore();
  });

  it('leaves them out of a Gemini request', async () => {
    const bodies: any[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] } }] })}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const { agent } = await agentWith(google);
    await agent.sendMessage({ text: 'hi' }, noCallbacks());
    const names = bodies[0].tools[0].functionDeclarations.map((t: any) => t.name);
    expect(names).toContain('mcp__gh__search');
    expect(JSON.stringify(bodies[0])).not.toContain('delete_repo');
    fetchSpy.mockRestore();
  });

  it('sends exactly what the Customizations page counts', async () => {
    const bodies: any[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      return textReply();
    });
    const { agent, manager } = await agentWith(openai);
    await agent.sendMessage({ text: 'hi' }, noCallbacks());
    const usage = summarizeToolUsage(manager.statuses(), TOOL_DEFINITIONS);
    expect(bodies[0].tools).toHaveLength(usage.totalTools);
    expect(usage.mcpTools).toBe(1);
    fetchSpy.mockRestore();
  });

  it('tells the model when it calls one anyway, without asking the user or touching the server', async () => {
    const bodies: any[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      if (bodies.length > 1) return textReply();
      const call = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'mcp__gh__delete_repo', arguments: '{}' } }] } }] };
      return new Response(`data: ${JSON.stringify(call)}\n\ndata: [DONE]\n\n`, { status: 200 });
    });
    const called: string[] = [];
    const asked: string[] = [];
    const { agent } = await agentWith(openai, ['delete_repo'], (name) => called.push(name));
    await agent.sendMessage({ text: 'delete it' }, noCallbacks(asked));
    expect(called).toEqual([]);
    expect(asked).toEqual([]);
    expect(bodies[1].messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('turned off') });
    fetchSpy.mockRestore();
  });

  it('still asks before running a tool that is on', async () => {
    let requests = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (++requests > 1) return textReply();
      const call = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'mcp__gh__search', arguments: '{}' } }] } }] };
      return new Response(`data: ${JSON.stringify(call)}\n\ndata: [DONE]\n\n`, { status: 200 });
    });
    const called: string[] = [];
    const asked: string[] = [];
    const { agent } = await agentWith({ ...openai, autoPilot: true }, ['delete_repo'], (name) => called.push(name));
    await agent.sendMessage({ text: 'find it' }, noCallbacks(asked));
    expect(asked).toEqual(['mcp__gh__search']);
    expect(called).toEqual(['search']);
    fetchSpy.mockRestore();
  });

  it('shows a clear message instead of the raw API error when the provider refuses the tool list', async () => {
    const bodies: any[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      const sent = bodies[0].tools.length;
      const raw = {
        error: {
          message: `Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length ${sent} instead.`,
          type: 'invalid_request_error',
          param: 'tools',
          code: 'array_above_max_length',
        },
      };
      return new Response(JSON.stringify(raw), { status: 400 });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const many = Array.from({ length: 130 }, (_, i) => ({ name: `tool_${i}`, inputSchema: { type: 'object', properties: {} } }));
    const { agent } = await agentWith(openai, [], () => {}, many);
    const failure = (await agent.sendMessage({ text: 'hi' }, noCallbacks()).catch((err: Error) => err)) as Error;
    const sent = bodies[0].tools.length;
    expect(failure.message).toContain(`OpenAI GPT accepts at most 128 tools per request, but this request sent ${sent}.`);
    expect(failure.message).toContain(`at least ${sent - 128} tools`);
    expect(failure.message).toContain('Customizations');
    expect(failure.message).not.toContain('invalid_request_error');
    // ยังใช้แชทเดิมต่อได้ ไม่มีการลองซ้ำเพราะคำตอบแบบนี้ลองใหม่ก็ไม่ผ่าน
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(agent.exportHistory()!).history[0]).toEqual({ role: 'user', content: 'hi' });
    fetchSpy.mockRestore();
    warn.mockRestore();
  });

  it('leaves the error alone when the tools are not the problem', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 })
    );
    const { agent } = await agentWith(openai);
    await expect(agent.sendMessage({ text: 'hi' }, noCallbacks())).rejects.toThrow(/API Error \[401\].*Incorrect API key/);
    fetchSpy.mockRestore();
  });

  it('explains a refusal from the Gemini SDK too', async () => {
    const raw = {
      error: {
        code: 400,
        message: 'The GenerateContentRequest proto is invalid:\n  * tools[0].function_declarations: [FIELD_INVALID] At most 512 function declarations can be specified.',
        status: 'INVALID_ARGUMENT',
      },
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(raw), { status: 400, headers: { 'content-type': 'application/json' } })
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const many = Array.from({ length: 600 }, (_, i) => ({ name: `tool_${i}`, inputSchema: { type: 'object', properties: {} } }));
    const { agent } = await agentWith(google, [], () => {}, many);
    const failure = (await agent.sendMessage({ text: 'hi' }, noCallbacks()).catch((err: Error) => err)) as Error;
    expect(failure.message).toContain('Google Gemini accepts at most 512 tools');
    expect(failure.message).toContain('Customizations');
    expect(failure.message).not.toContain('FIELD_INVALID');
    fetchSpy.mockRestore();
    warn.mockRestore();
  });

  describe('Claude thinking blocks', () => {
    const thinkingIn = (body: any) => JSON.stringify(body.messages).includes('"thinking"');

    async function twoTurns(changeBetween: (manager: McpManager) => void) {
      const bodies: any[] = [];
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        bodies.push(JSON.parse(String(init!.body)));
        return claudeResponse({ text: 'done' });
      });
      const { agent, manager } = await agentWith(anthropic, []);
      await agent.sendMessage({ text: 'first' }, noCallbacks());
      changeBetween(manager);
      await agent.sendMessage({ text: 'second' }, noCallbacks());
      fetchSpy.mockRestore();
      return { bodies, agent };
    }

    it('are sent back while the tools stay the same', async () => {
      const { bodies } = await twoTurns(() => {});
      expect(thinkingIn(bodies[1])).toBe(true);
    });

    it('are removed once a tool is turned off, because the API would refuse them on every later request', async () => {
      const { bodies, agent } = await twoTurns((manager) => manager.sync(parseMcpConfig(mcpConfig(['delete_repo'])).servers, ''));
      expect(bodies[0].tools.length - bodies[1].tools.length).toBe(1);
      expect(thinkingIn(bodies[1])).toBe(false);
      // ข้อความเดิมยังอยู่ครบ และ thinking ของเทิร์นใหม่กลับมาใช้ได้ตามปกติ
      expect(JSON.stringify(bodies[1].messages)).toContain('first');
      expect(JSON.stringify(bodies[1].messages)).toContain('done');
      expect(JSON.parse(agent.exportHistory()!).history.at(-1).content[0].type).toBe('thinking');
    });

    it('survive only if the saved chat was made with the same tools', async () => {
      const { agent } = await twoTurns(() => {});
      const snapshot = agent.exportHistory()!;
      const resend = async (saved: string, disabled: string[]) => {
        const bodies: any[] = [];
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
          bodies.push(JSON.parse(String(init!.body)));
          return claudeResponse({ text: 'done' });
        });
        const { agent: reopened } = await agentWith(anthropic, disabled);
        expect(reopened.restoreHistory(saved, reopened.historyVersion)).toBe(true);
        await reopened.sendMessage({ text: 'third' }, noCallbacks());
        fetchSpy.mockRestore();
        return bodies[0];
      };
      expect(thinkingIn(await resend(snapshot, []))).toBe(true);
      expect(thinkingIn(await resend(snapshot, ['delete_repo']))).toBe(false);
      // ประวัติรุ่นก่อนไม่บอกว่าใช้ tool ชุดไหน จึงถือว่าเปลี่ยนไว้ก่อน
      const { toolSetId: _old, ...legacy } = JSON.parse(snapshot);
      expect(thinkingIn(await resend(JSON.stringify(legacy), []))).toBe(false);
    });
  });
});

describe('rewindBeforeUserTurn', () => {
  const restore = (agent: MultiProviderAgentService, history: unknown[]) =>
    agent.restoreHistory(JSON.stringify({ v: 1, format: 'openai', history }), agent.historyVersion);

  const history = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'body' },
    { role: 'assistant', content: 'answer one' },
    { role: 'user', content: '[Note from the app: files reverted]\n\nsecond question' },
    { role: 'assistant', content: 'answer two' },
  ];

  it('cuts right before the matching user turn and keeps earlier tool context', () => {
    const agent = new MultiProviderAgentService(settings());
    restore(agent, history);
    expect(agent.rewindBeforeUserTurn('second question', 1)).toBe(true);
    expect(JSON.parse(agent.exportHistory()!).history).toEqual(history.slice(0, 4));
  });

  it('refuses when the text does not match or the turn is gone', () => {
    const agent = new MultiProviderAgentService(settings());
    restore(agent, history);
    expect(agent.rewindBeforeUserTurn('something else', 1)).toBe(false);
    expect(agent.rewindBeforeUserTurn('first question', 3)).toBe(false);
    expect(agent.rewindBeforeUserTurn('first question', 2)).toBe(true);
    expect(agent.exportHistory()).toBeNull();
    expect(new MultiProviderAgentService(settings()).rewindBeforeUserTurn('x', 1)).toBe(false);
  });
});
