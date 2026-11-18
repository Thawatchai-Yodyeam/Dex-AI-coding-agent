import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ToolCallRecord } from '../../types/agent';

const bridge = vi.hoisted(() => ({
  webSearch: vi.fn(async (): Promise<{ title: string; url: string; snippet: string }[]> => []),
}));
vi.mock('../tauriBridge', () => ({ tauriBridge: bridge }));

import { runAnthropicTurn } from './providers/anthropic';
import { chatBuiltinTools, subagentTools } from './subagent';
import { executeTool } from './tools';
import type { AgentCallbacks, TurnContext } from './types';
import {
  CLAUDE_WEB_SEARCH_MAX_USES,
  claudeSearchOutcome,
  claudeWebSearchTool,
  usesClientWebSearch,
  usesNativeWebSearch,
} from './webSearch';
import { blockedInPlanMode } from './planMode';

const base = { cwd: 'D:\\proj', autoPilot: true, permissionRules: [], language: 'en' } as unknown as AppSettings;
const names = (tools: { name: string }[]) => tools.map((t) => t.name);

describe('which search the chat uses', () => {
  it('sends Dex web_search only when a service is chosen and Claude search is not taking over', () => {
    expect(usesClientWebSearch({ provider: 'openai' })).toBe(false);
    expect(usesClientWebSearch({ provider: 'openai', webSearchProvider: 'brave' })).toBe(true);
    expect(usesClientWebSearch({ provider: 'google', webSearchProvider: 'tavily', claudeWebSearch: true })).toBe(true);
    expect(usesClientWebSearch({ provider: 'anthropic', webSearchProvider: 'brave', claudeWebSearch: true })).toBe(false);
    expect(usesClientWebSearch({ provider: 'anthropic', webSearchProvider: 'brave' })).toBe(true);
    expect(usesClientWebSearch({ provider: 'openai', webSearchProvider: 'bing' as any })).toBe(false);
  });

  it('uses Claude search only for Claude with the option on', () => {
    expect(usesNativeWebSearch({ provider: 'anthropic', claudeWebSearch: true })).toBe(true);
    expect(usesNativeWebSearch({ provider: 'anthropic' })).toBe(false);
    expect(usesNativeWebSearch({ provider: 'google', claudeWebSearch: true })).toBe(false);
  });

  it('adds web_search to the chat and subagent tools exactly when it is used', () => {
    expect(names(chatBuiltinTools({ provider: 'openai' }))).not.toContain('web_search');
    const withSearch = chatBuiltinTools({ provider: 'openai', webSearchProvider: 'brave' });
    expect(names(withSearch)).toContain('web_search');
    expect(names(subagentTools(withSearch, [], [], () => false))).toContain('web_search');
    expect(names(chatBuiltinTools({ provider: 'anthropic', webSearchProvider: 'brave', claudeWebSearch: true }))).not.toContain('web_search');
  });

  it('is allowed in Plan mode', () => {
    expect(blockedInPlanMode('web_search', { query: 'x' })).toBe(false);
  });
});

describe('claudeWebSearchTool', () => {
  it('uses dynamic filtering on the models that support it and the basic tool on the rest', () => {
    for (const model of ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-opus-4-6', 'claude-sonnet-4-6']) {
      expect(claudeWebSearchTool(model).type, model).toBe('web_search_20260209');
    }
    for (const model of ['claude-haiku-5-5', 'claude-haiku-4-5', 'claude-sonnet-4-5']) {
      expect(claudeWebSearchTool(model).type, model).toBe('web_search_20250305');
    }
    expect(claudeWebSearchTool('claude-opus-5-5')).toMatchObject({ name: 'web_search', max_uses: CLAUDE_WEB_SEARCH_MAX_USES });
  });

  it('reads results and error objects', () => {
    expect(claudeSearchOutcome({ content: [{ url: 'https://a', title: 'A' }, { title: 'no url' }] })).toEqual({
      hits: [{ title: 'A', url: 'https://a' }],
    });
    expect(claudeSearchOutcome({ content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } })).toEqual({
      hits: [],
      error: 'max_uses_exceeded',
    });
  });
});

describe('web_search tool', () => {
  const callbacks = (approvals: string[] = []): AgentCallbacks => ({
    onTextChunk: () => {},
    onToolStart: () => {},
    onToolUpdate: () => {},
    onRequestApproval: async (t) => {
      approvals.push(t.name);
      return 'once';
    },
  });

  beforeEach(() => vi.clearAllMocks());

  it('searches through the chosen service and returns the results', async () => {
    bridge.webSearch.mockResolvedValueOnce([{ title: 'Rust', url: 'https://rust-lang.org', snippet: 's' }]);
    const res: any = await executeTool('web_search', { query: ' rust ', count: 50 }, { ...base, webSearchProvider: 'brave' }, callbacks());
    expect(bridge.webSearch).toHaveBeenCalledWith('brave', 'rust', 10);
    expect(res.results).toEqual([{ title: 'Rust', url: 'https://rust-lang.org', snippet: 's' }]);
    expect(res.note).toContain('untrusted');
  });

  it('explains a missing key instead of retrying', async () => {
    bridge.webSearch.mockRejectedValueOnce('NO_SEARCH_KEY: no key for tavily');
    const res: any = await executeTool('web_search', { query: 'x' }, { ...base, webSearchProvider: 'tavily' }, callbacks());
    expect(res.error).toBe('no key for tavily Tell the user; do not retry.');
  });

  it('refuses when search is off or the query is empty', async () => {
    expect(await executeTool('web_search', { query: 'x' }, base, callbacks())).toMatchObject({ error: expect.stringContaining('turned off') });
    expect(await executeTool('web_search', { query: ' ' }, { ...base, webSearchProvider: 'brave' }, callbacks())).toEqual({
      error: 'web_search needs a query',
    });
    expect(bridge.webSearch).not.toHaveBeenCalled();
  });

  it('asks in Supervised mode and honours a deny rule for the service', async () => {
    const approvals: string[] = [];
    await executeTool('web_search', { query: 'x' }, { ...base, autoPilot: false, webSearchProvider: 'brave' }, callbacks(approvals));
    expect(approvals).toEqual(['web_search']);

    const denied = {
      ...base,
      webSearchProvider: 'brave',
      permissionRules: [{ id: 'r', tool: 'web', pattern: 'api.search.brave.com', action: 'deny' }],
    } as unknown as AppSettings;
    expect(await executeTool('web_search', { query: 'x' }, denied, callbacks())).toMatchObject({ error: expect.stringContaining('deny') });
    expect(bridge.webSearch).toHaveBeenCalledTimes(1);
  });
});

describe('Claude built-in search in the driver', () => {
  const sse = (events: object[]) =>
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });

  const searchStep = sse([
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"rust 2026"}' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: 'srv1',
        content: [{ type: 'web_search_result', url: 'https://a.example', title: 'A', encrypted_content: 'enc' }],
      },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 5 } },
  ]);
  const answerStep = sse([
    { type: 'message_start', message: { usage: { input_tokens: 20 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Answer' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  ]);

  afterEach(() => vi.restoreAllMocks());

  it('declares the server tool, resumes after pause_turn and shows the search as a card', async () => {
    const bodies: any[] = [];
    const replies = [searchStep, answerStep];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      return replies.shift()!;
    });
    const started: ToolCallRecord[] = [];
    const updated: ToolCallRecord[] = [];
    const ran: string[] = [];
    const ctx: TurnContext = {
      settings: { ...base, provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'medium' } as AppSettings,
      apiKey: 'k',
      history: [],
      tools: [],
      callbacks: {
        onTextChunk: () => {},
        onToolStart: (t) => started.push(t),
        onToolUpdate: (t) => updated.push(t),
        onRequestApproval: async () => 'once',
      },
      systemPrompt: 'sys',
      runTool: async (name) => {
        ran.push(name);
        return {};
      },
      nativeWebSearch: true,
    };

    const res = await runAnthropicTurn(ctx, { text: 'what is new in rust?' });

    expect(res.text).toBe('Answer');
    expect(bodies[0].tools).toEqual([claudeWebSearchTool('claude-opus-5-5')]);
    expect(bodies[0].tools[0]).not.toHaveProperty('eager_input_streaming');
    // รอบที่สองส่งประวัติเดิมไปต่อ ไม่มีข้อความ user เพิ่ม และ block ของ server tool ส่งกลับครบ
    const resumed = bodies[1].messages;
    expect(resumed.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(resumed[1].content[0]).toEqual({ type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'rust 2026' } });
    expect(resumed[1].content[1].content[0].encrypted_content).toBe('enc');
    expect(ran).toEqual([]);

    expect(started).toEqual([{ id: 'srv1', name: 'web_search', args: { query: 'rust 2026' }, status: 'running' }]);
    expect(updated.at(-1)).toMatchObject({ id: 'srv1', status: 'completed', output: 'A — https://a.example' });
  });

  it('leaves the server tool out when built-in search is off', async () => {
    const bodies: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      return sse([
        { type: 'message_start', message: { usage: {} } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      ]);
    });
    await runAnthropicTurn(
      {
        settings: { ...base, provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'medium' } as AppSettings,
        apiKey: 'k',
        history: [],
        tools: [],
        callbacks: { onTextChunk: () => {}, onToolStart: () => {}, onToolUpdate: () => {}, onRequestApproval: async () => 'once' },
        systemPrompt: 'sys',
        runTool: async () => ({}),
      },
      { text: 'hi' }
    );
    expect(bodies[0]).not.toHaveProperty('tools');
  });
});
