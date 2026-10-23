import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../types/agent';

const bridge = vi.hoisted(() => ({ readFile: vi.fn(), listDir: vi.fn(async () => []) }));
vi.mock('../tauriBridge', () => ({ tauriBridge: bridge }));

import { MultiProviderAgentService, STEPS_PER_CONFIRM } from './AgentService';
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
