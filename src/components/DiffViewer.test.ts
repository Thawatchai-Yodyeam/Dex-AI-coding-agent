import { describe, expect, it } from 'vitest';
import { computeLineDiff } from './DiffViewer';

describe('computeLineDiff', () => {
  it('returns nothing for two empty texts', () => {
    expect(computeLineDiff('', '')).toEqual([]);
  });

  it('marks identical text as unchanged', () => {
    expect(computeLineDiff('a\nb', 'a\nb')).toEqual([
      { type: 'unchanged', content: 'a' },
      { type: 'unchanged', content: 'b' },
    ]);
  });

  it('shows pure additions and removals', () => {
    expect(computeLineDiff('', 'x\ny')).toEqual([
      { type: 'added', content: 'x' },
      { type: 'added', content: 'y' },
    ]);
    expect(computeLineDiff('x', '')).toEqual([{ type: 'removed', content: 'x' }]);
  });

  it('keeps unchanged context around a changed line', () => {
    expect(computeLineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { type: 'unchanged', content: 'a' },
      { type: 'removed', content: 'b' },
      { type: 'added', content: 'B' },
      { type: 'unchanged', content: 'c' },
    ]);
  });

  it('handles insertions in the middle', () => {
    expect(computeLineDiff('a\nc', 'a\nb\nc')).toEqual([
      { type: 'unchanged', content: 'a' },
      { type: 'added', content: 'b' },
      { type: 'unchanged', content: 'c' },
    ]);
  });

  it('treats CRLF and LF line endings the same', () => {
    expect(computeLineDiff('a\r\nb', 'a\nb').every((l) => l.type === 'unchanged')).toBe(true);
  });

  it('reconstructs both texts from the diff', () => {
    const oldText = 'one\ntwo\nthree\nfour\nfive';
    const newText = 'zero\none\nthree\nfour!\nfive\nsix';
    const diff = computeLineDiff(oldText, newText);
    const rebuiltOld = diff.filter((l) => l.type !== 'added').map((l) => l.content).join('\n');
    const rebuiltNew = diff.filter((l) => l.type !== 'removed').map((l) => l.content).join('\n');
    expect(rebuiltOld).toBe(oldText);
    expect(rebuiltNew).toBe(newText);
    expect(diff.filter((l) => l.type === 'unchanged').map((l) => l.content)).toEqual(['one', 'three', 'five']);
  });

  it('falls back to remove-all/add-all for very large inputs', () => {
    const big = (prefix: string) => Array.from({ length: 501 }, (_, i) => `${prefix}${i}`).join('\n');
    const diff = computeLineDiff(big('a'), big('a'));
    expect(diff).toHaveLength(1002);
    expect(diff.slice(0, 501).every((l) => l.type === 'removed')).toBe(true);
    expect(diff.slice(501).every((l) => l.type === 'added')).toBe(true);
  });
});
