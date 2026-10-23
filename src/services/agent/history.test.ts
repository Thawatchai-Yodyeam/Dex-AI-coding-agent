import { describe, expect, it } from 'vitest';
import {
  CLEARED_TOOL_RESULT,
  estimateHistoryChars,
  fromNeutral,
  isUserTextTurn,
  pruneHistory,
  pruneHistoryToBudget,
  toNeutral,
  trimToolResults,
} from './history';
import type { HistoryFormat, NeutralMessage } from './types';

const conversation: NeutralMessage[] = [
  { role: 'user', text: 'hello' },
  { role: 'assistant', text: 'hi there' },
  { role: 'user', text: 'list files' },
  { role: 'assistant', text: 'here they are' },
];

describe('toNeutral / fromNeutral', () => {
  it.each<HistoryFormat>(['google', 'anthropic', 'openai'])('round-trips an alternating conversation (%s)', (format) => {
    expect(toNeutral(fromNeutral(conversation, format), format)).toEqual(conversation);
  });

  it('produces provider-native shapes', () => {
    expect(fromNeutral(conversation.slice(0, 2), 'google')).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi there' }] },
    ]);
    expect(fromNeutral(conversation.slice(0, 2), 'anthropic')).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
  });

  it('merges consecutive messages of the same role', () => {
    const msgs: NeutralMessage[] = [
      { role: 'user', text: 'a' },
      { role: 'user', text: 'b' },
    ];
    expect(fromNeutral(msgs, 'google')).toEqual([{ role: 'user', parts: [{ text: 'a' }, { text: 'b' }] }]);
    expect(fromNeutral(msgs, 'openai')).toEqual([{ role: 'user', content: 'a\n\nb' }]);
  });

  it('prepends a user turn for google/anthropic when history starts with the assistant', () => {
    const msgs: NeutralMessage[] = [{ role: 'assistant', text: 'resumed' }];
    expect(fromNeutral(msgs, 'anthropic')[0]).toEqual({ role: 'user', content: '(continued conversation)' });
    expect(fromNeutral(msgs, 'google')[0]).toEqual({ role: 'user', parts: [{ text: '(continued conversation)' }] });
    expect(fromNeutral(msgs, 'openai')).toEqual([{ role: 'assistant', content: 'resumed' }]);
  });

  it('drops google thoughts and function calls/responses', () => {
    const history = [
      { role: 'user', parts: [{ text: 'q' }] },
      { role: 'model', parts: [{ text: 'thinking...', thought: true }, { functionCall: { name: 'read_file', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: {} } }] },
      { role: 'model', parts: [{ text: 'answer' }] },
    ];
    expect(toNeutral(history, 'google')).toEqual([
      { role: 'user', text: 'q' },
      { role: 'assistant', text: 'answer' },
    ]);
  });

  it('drops anthropic thinking, tool_use and tool_result blocks', () => {
    const history = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig' },
          { type: 'text', text: 'let me look' },
          { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];
    expect(toNeutral(history, 'anthropic')).toEqual([
      { role: 'user', text: 'q' },
      { role: 'assistant', text: 'let me look' },
      { role: 'assistant', text: 'done' },
    ]);
  });

  it('drops openai tool messages and tool-call-only assistant turns', () => {
    const history = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'result' },
      { role: 'assistant', content: 'answer' },
    ];
    expect(toNeutral(history, 'openai')).toEqual([
      { role: 'user', text: 'q' },
      { role: 'assistant', text: 'answer' },
    ]);
  });
});

describe('isUserTextTurn', () => {
  it('distinguishes typed user messages from wrapped tool results', () => {
    expect(isUserTextTurn({ role: 'user', content: 'hi' }, 'anthropic')).toBe(true);
    expect(isUserTextTurn({ role: 'user', content: [{ type: 'tool_result' }] }, 'anthropic')).toBe(false);
    expect(isUserTextTurn({ role: 'user', parts: [{ text: 'hi' }] }, 'google')).toBe(true);
    expect(isUserTextTurn({ role: 'user', parts: [{ functionResponse: {} }] }, 'google')).toBe(false);
    expect(isUserTextTurn({ role: 'tool', content: 'r' }, 'openai')).toBe(false);
    expect(isUserTextTurn({ role: 'assistant', content: 'a' }, 'openai')).toBe(false);
  });
});

describe('pruneHistory', () => {
  const anthropicHistory = () => [
    { role: 'user', content: 'q1' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan', signature: 's1' },
        { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
    { role: 'user', content: 'q2' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan2', signature: 's2' },
        { type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'b' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'data2' }] },
    {
      role: 'assistant',
      content: [
        { type: 'redacted_thinking', data: 'xyz' },
        { type: 'text', text: 'a2' },
      ],
    },
  ];

  it('returns the same array when under the limit (thinking kept)', () => {
    const h = anthropicHistory();
    expect(pruneHistory(h, 'anthropic', 100)).toBe(h);
  });

  it('never starts the kept history on a tool result', () => {
    const h = anthropicHistory();
    // ทุกขนาดที่ทำให้ต้องตัด: ข้อความแรกที่เหลือต้องเป็นข้อความที่ผู้ใช้พิมพ์ และ tool_use ทุกตัวต้องมี tool_result คู่
    for (let max = 1; max < h.length; max++) {
      const kept = pruneHistory(h, 'anthropic', max);
      expect(isUserTextTurn(kept[0], 'anthropic')).toBe(true);
      const useIds = kept.flatMap((m: any) =>
        Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'tool_use').map((b: any) => b.id) : []
      );
      const resultIds = kept.flatMap((m: any) =>
        Array.isArray(m.content)
          ? m.content.filter((b: any) => b.type === 'tool_result').map((b: any) => b.tool_use_id)
          : []
      );
      expect(resultIds.sort()).toEqual(useIds.sort());
    }
  });

  it('cuts forward to the next user turn and strips anthropic thinking after a prune', () => {
    const kept = pruneHistory(anthropicHistory(), 'anthropic', 6);
    expect(kept[0]).toEqual({ role: 'user', content: 'q2' });
    expect(kept).toHaveLength(4);
    for (const m of kept) {
      if (Array.isArray(m.content)) {
        expect(m.content.some((b: any) => b.type === 'thinking' || b.type === 'redacted_thinking')).toBe(false);
      }
    }
    expect(kept[1].content).toEqual([{ type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'b' } }]);
    expect(kept[3].content).toEqual([{ type: 'text', text: 'a2' }]);
  });

  it('removes assistant messages that held only thinking', () => {
    const h = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'only', signature: 's' }] },
    ];
    expect(pruneHistory(h, 'anthropic', 2)).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('does not mutate the input history', () => {
    const h = anthropicHistory();
    const snapshot = JSON.parse(JSON.stringify(h));
    pruneHistory(h, 'anthropic', 3);
    expect(h).toEqual(snapshot);
  });

  it('keeps everything when no user turn exists after the cut point', () => {
    const h = anthropicHistory().slice(0, 4);
    expect(pruneHistory(h, 'anthropic', 2)).toBe(h);
  });

  it('keeps google functionCall/functionResponse pairs together', () => {
    const h = [
      { role: 'user', parts: [{ text: 'q1' }] },
      { role: 'model', parts: [{ functionCall: { name: 'x', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'x', response: {} } }] },
      { role: 'model', parts: [{ text: 'a1' }] },
      { role: 'user', parts: [{ text: 'q2' }] },
      { role: 'model', parts: [{ text: 'a2' }] },
    ];
    expect(pruneHistory(h, 'google', 4)).toEqual(h.slice(4));
  });

  it('keeps openai tool_calls with their tool messages', () => {
    const h = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
      { role: 'tool', tool_call_id: 'c1', content: 'r' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ];
    expect(pruneHistory(h, 'openai', 5)).toEqual(h.slice(4));
  });
});

describe('context budget', () => {
  const big = (n: number) => 'x'.repeat(n);

  /** เทิร์นเดียวที่เรียก tool หลายรอบ (รูปแบบ OpenAI) */
  function openaiLoop(results: number, size: number) {
    const h: any[] = [{ role: 'user', content: 'refactor everything' }];
    for (let i = 0; i < results; i++) {
      h.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
      h.push({ role: 'tool', tool_call_id: `c${i}`, content: big(size) });
    }
    return h;
  }

  it('counts images as a fixed cost instead of their base64 length', () => {
    const image = { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'A'.repeat(500_000) } }] };
    expect(estimateHistoryChars([image])).toBeLessThan(10_000);
    expect(estimateHistoryChars([{ role: 'user', content: big(50_000) }])).toBeGreaterThan(50_000);
  });

  it('clears the oldest tool results first and keeps the recent ones and every pair', () => {
    const h = openaiLoop(20, 30_000);
    const cleared = trimToolResults(h, 'openai', 400_000);
    expect(cleared).toBeGreaterThan(0);
    const tools = h.filter((m) => m.role === 'tool');
    expect(tools).toHaveLength(20);
    expect(tools[0].content).toBe(CLEARED_TOOL_RESULT);
    // 8 ตัวล่าสุด (240k) ไม่ถูกแตะ แม้จะทำให้ลงไม่ถึงเป้า 60%
    expect(tools.slice(-8).every((m) => m.content.length === 30_000)).toBe(true);
    expect(tools.slice(0, 12).every((m) => m.content === CLEARED_TOOL_RESULT)).toBe(true);
    expect(estimateHistoryChars(h)).toBeLessThanOrEqual(400_000);
  });

  it('does nothing while under budget', () => {
    const h = openaiLoop(3, 1_000);
    expect(trimToolResults(h, 'openai', 400_000)).toBe(0);
  });

  it('clears Anthropic tool_result blocks and Gemini functionResponses', () => {
    const anth: any[] = [{ role: 'user', content: 'go' }];
    const gem: any[] = [{ role: 'user', parts: [{ text: 'go' }] }];
    for (let i = 0; i < 12; i++) {
      anth.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'read_file', input: {} }] });
      anth.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big(10_000) }] });
      gem.push({ role: 'model', parts: [{ functionCall: { name: 'read_file', args: {} } }] });
      gem.push({ role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { content: big(10_000) } } }] });
    }
    expect(trimToolResults(anth, 'anthropic', 50_000)).toBeGreaterThan(0);
    expect(anth[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't0', content: CLEARED_TOOL_RESULT });
    expect(trimToolResults(gem, 'google', 50_000)).toBeGreaterThan(0);
    expect(gem[2].parts[0].functionResponse).toEqual({ name: 'read_file', response: { result: CLEARED_TOOL_RESULT } });
  });

  it('drops whole old turns when plain text alone is over budget, but keeps the latest turn', () => {
    const h: any[] = [];
    for (let i = 0; i < 6; i++) {
      h.push({ role: 'user', content: `q${i} ${big(30_000)}` });
      h.push({ role: 'assistant', content: `a${i} ${big(30_000)}` });
    }
    const out = pruneHistoryToBudget(h, 'openai', 200_000);
    expect(out.length).toBeLessThan(h.length);
    expect(isUserTextTurn(out[0], 'openai')).toBe(true);
    expect(out[out.length - 1].content.startsWith('a5')).toBe(true);
    expect(estimateHistoryChars(out)).toBeLessThanOrEqual(200_000);
  });
});
