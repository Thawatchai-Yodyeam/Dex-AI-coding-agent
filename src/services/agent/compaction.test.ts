import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../types/agent';
import { compactHistory, compactionCut, fitTranscript, historyToTranscript } from './compaction';
import type { TurnContext, UserInput } from './types';

describe('historyToTranscript', () => {
  it('reads OpenAI tool calls and results', () => {
    const lines = historyToTranscript(
      [
        { role: 'user', content: 'fix the bug' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(5000) },
        { role: 'assistant', content: 'fixed' },
      ],
      'openai'
    );
    expect(lines[0]).toBe('User: fix the bug');
    expect(lines[1]).toBe('Assistant called read_file({"path":"a.ts"})');
    expect(lines[2]).toMatch(/^Tool result: x+ … \[3500 more chars\]$/);
    expect(lines[3]).toBe('Assistant: fixed');
  });

  it('skips thinking and reads Claude and Gemini blocks', () => {
    expect(
      historyToTranscript(
        [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'tool_use', name: 'grep_search', input: { query: 'x' } }] },
          { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: '3 matches' }] }] },
        ],
        'anthropic'
      )
    ).toEqual(['User: hi', 'Assistant called grep_search({"query":"x"})', 'Tool result: 3 matches']);
    expect(
      historyToTranscript(
        [
          { role: 'model', parts: [{ text: 'plan', thought: true }, { functionCall: { name: 'find_files', args: { pattern: '*.ts' } } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'find_files', response: { result: 'a.ts' } } }] },
        ],
        'google'
      )
    ).toEqual(['Assistant called find_files({"pattern":"*.ts"})', 'Tool result: a.ts']);
  });
});

describe('fitTranscript', () => {
  it('keeps the first line and as many recent lines as fit', () => {
    const lines = ['User: earlier summary', ...Array.from({ length: 10 }, (_, i) => `line ${i} ${'x'.repeat(40)}`)];
    const out = fitTranscript(lines, 250);
    expect(out.startsWith('User: earlier summary\n[… ')).toBe(true);
    expect(out.endsWith(lines[10])).toBe(true);
    expect(out.length).toBeLessThanOrEqual(250);
  });
});

const turn = (q: string, size: number) => [
  { role: 'user', content: q },
  { role: 'assistant', content: 'a'.repeat(size) },
];

describe('compactionCut', () => {
  it('keeps the last two turns, or only the last one when they are large', () => {
    expect(compactionCut([...turn('1', 10), ...turn('2', 10), ...turn('3', 10)], 'openai')).toBe(2);
    expect(compactionCut([...turn('1', 10), ...turn('2', 200_000), ...turn('3', 10)], 'openai')).toBe(4);
    expect(compactionCut(turn('only', 10), 'openai')).toBeNull();
  });
});

describe('compactHistory', () => {
  const settings = { provider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: 'high', language: 'en' } as AppSettings;

  it('summarizes older turns without tools and keeps recent ones in full', async () => {
    const run = vi.fn(async (ctx: TurnContext, input: UserInput) => {
      expect(ctx.tools).toEqual([]);
      expect(ctx.settings.reasoningEffort).toBe('none');
      expect(ctx.systemPrompt).toContain('compress the earlier part');
      expect(input.text).toContain('User: 1');
      expect(input.text).not.toContain('User: 3');
      return { text: '- user wants X', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
    });
    const history = [...turn('1', 10), ...turn('2', 10), ...turn('3', 10)];
    const res = await compactHistory(history, 'openai', run, { settings, apiKey: 'k' });
    expect(res!.usage.totalTokens).toBe(15);
    expect(res!.history[0].role).toBe('user');
    expect(res!.history[0].content).toContain('<conversation_summary>\n- user wants X\n</conversation_summary>');
    expect(res!.history[1].role).toBe('assistant');
    expect(res!.history.slice(2)).toEqual(history.slice(2));
  });

  it('strips Claude thinking from kept turns and fails on an empty summary', async () => {
    const history = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
      { role: 'user', content: 'new' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'text', text: 'new answer' }] },
    ];
    const ok = async () => ({ text: 'sum', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
    const res = await compactHistory(history, 'anthropic', ok, { settings, apiKey: 'k' });
    expect(res!.history.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'new answer' }] });

    const empty = async () => ({ text: '  ', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
    await expect(compactHistory(history, 'anthropic', empty, { settings, apiKey: 'k' })).rejects.toThrow(/empty summary/);
  });
});
