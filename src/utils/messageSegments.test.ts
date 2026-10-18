import { describe, expect, it } from 'vitest';
import type { ToolCallRecord } from '../types/agent';
import { buildMessageSegments } from './messageSegments';

const tool = (id: string, contentOffset?: number, thoughtOffset?: number): ToolCallRecord => ({
  id,
  name: 'run_shell_command',
  args: {},
  status: 'completed',
  contentOffset,
  thoughtOffset,
});

describe('buildMessageSegments', () => {
  it('returns a single text segment when there are no tools', () => {
    expect(buildMessageSegments('hello', [])).toEqual([{ kind: 'text', text: 'hello', step: 0 }]);
  });

  it('places tools between the text said before and after them', () => {
    const before = "It's the Vite dev server. Stopping it:";
    const content = `${before}\n\nPort is free now.`;
    const t1 = tool('t1', before.length, 0);
    expect(buildMessageSegments(content, [t1])).toEqual([
      { kind: 'text', text: before, step: 0 },
      { kind: 'tools', tools: [t1], step: 0 },
      { kind: 'text', text: '\n\nPort is free now.', step: 1 },
    ]);
  });

  it('splits thinking per step: thought → text → tools, then the next step', () => {
    const thought = 'Look at the port first.Now kill it.Done, confirm.';
    const content = 'Checking.\n\nStopping it:\n\nFree now.';
    const a = tool('a', 'Checking.'.length, 'Look at the port first.'.length);
    const b = tool('b', 'Checking.\n\nStopping it:'.length, 'Look at the port first.Now kill it.'.length);
    expect(buildMessageSegments(content, [a, b], thought)).toEqual([
      { kind: 'thought', text: 'Look at the port first.', step: 0 },
      { kind: 'text', text: 'Checking.', step: 0 },
      { kind: 'tools', tools: [a], step: 0 },
      { kind: 'thought', text: 'Now kill it.', step: 1 },
      { kind: 'text', text: '\n\nStopping it:', step: 1 },
      { kind: 'tools', tools: [b], step: 1 },
      { kind: 'thought', text: 'Done, confirm.', step: 2 },
      { kind: 'text', text: '\n\nFree now.', step: 2 },
    ]);
  });

  it('ends on a thought segment while the model is still thinking', () => {
    const a = tool('a', 0, 5);
    const segments = buildMessageSegments('', [a], 'firstsecond');
    expect(segments[segments.length - 1]).toEqual({ kind: 'thought', text: 'second', step: 1 });
  });

  it('groups tools that started at the same point', () => {
    const a = tool('a', 4, 0);
    const b = tool('b', 4, 0);
    const c = tool('c', 9, 0);
    expect(buildMessageSegments('one\n\ntwo\n\nthree', [a, b, c])).toEqual([
      { kind: 'text', text: 'one\n', step: 0 },
      { kind: 'tools', tools: [a, b], step: 0 },
      { kind: 'text', text: '\ntwo\n', step: 1 },
      { kind: 'tools', tools: [c], step: 1 },
      { kind: 'text', text: '\nthree', step: 2 },
    ]);
  });

  it('shows old sessions (no offsets) as thought, tools, then text', () => {
    const t1 = tool('t1');
    expect(buildMessageSegments('answer', [t1], 'reasoning')).toEqual([
      { kind: 'thought', text: 'reasoning', step: 0 },
      { kind: 'tools', tools: [t1], step: 0 },
      { kind: 'text', text: 'answer', step: 1 },
    ]);
  });

  it('skips whitespace-only text between tools and clamps out-of-range offsets', () => {
    const a = tool('a', 0, 0);
    const b = tool('b', 2, 0);
    const c = tool('c', 99, 99);
    expect(buildMessageSegments('\n\nend', [a, b, c])).toEqual([
      { kind: 'tools', tools: [a, b], step: 0 },
      { kind: 'text', text: 'end', step: 1 },
      { kind: 'tools', tools: [c], step: 1 },
    ]);
  });
});
