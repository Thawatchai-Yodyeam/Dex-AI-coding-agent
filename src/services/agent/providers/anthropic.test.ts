import { describe, expect, it } from 'vitest';
import { withCacheBreakpoints } from './anthropic';

const EPH = { type: 'ephemeral' };

describe('withCacheBreakpoints', () => {
  it('marks the last two user messages without touching the original history', () => {
    const history: any[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'body' }] },
    ];
    const out = withCacheBreakpoints(history);
    expect(out[0]).toBe(history[0]);
    expect(out[2].content).toEqual([{ type: 'text', text: 'second', cache_control: EPH }]);
    expect(out[4].content[0].cache_control).toEqual(EPH);
    expect(history[2].content).toBe('second');
    expect(history[4].content[0].cache_control).toBeUndefined();
  });

  it('skips thinking blocks and empty strings', () => {
    const out = withCacheBreakpoints([
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'thinking', thinking: 'x', signature: 's' }] },
      { role: 'user', content: '' },
    ]);
    expect(out[0].content[0].cache_control).toEqual(EPH);
    expect(out[0].content[1].cache_control).toBeUndefined();
    expect(out[1].content).toBe('');
  });
});
