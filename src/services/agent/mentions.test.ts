import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileSlice } from '../tauriBridge';

const bridge = vi.hoisted(() => ({ readFileLines: vi.fn() }));
vi.mock('../tauriBridge', () => ({ tauriBridge: bridge }));

import { attachMentionedFiles, extractMentions, mentionQueryAt, rankMentionCandidates } from './mentions';

const slice = (content: string, end_line: number, total_lines = end_line): FileSlice => ({
  content,
  start_line: 1,
  end_line,
  total_lines,
  truncated_lines: 0,
});

describe('extractMentions', () => {
  it('finds @paths at word starts, drops trailing punctuation and duplicates', () => {
    expect(extractMentions('@src/App.tsx แล้วดู @README.md, กับ (@a.ts) @src/App.tsx')).toEqual([
      'src/App.tsx',
      'README.md',
    ]);
    expect(extractMentions('ส่งหา me@example.com ด้วย')).toEqual([]);
    expect(extractMentions('line one\n@docs/x.md.')).toEqual(['docs/x.md']);
  });
});

describe('mentionQueryAt', () => {
  it('returns the word being typed after @ at the caret', () => {
    expect(mentionQueryAt('ดู @src/Ap', 10)).toEqual({ start: 3, query: 'src/Ap' });
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQueryAt('@src/App.tsx ', 13)).toBeNull();
    expect(mentionQueryAt('me@ex', 5)).toBeNull();
    // caret อยู่กลางคำ: ดูแค่ส่วนก่อน caret
    expect(mentionQueryAt('@abc def', 2)).toEqual({ start: 0, query: 'a' });
  });
});

describe('rankMentionCandidates', () => {
  it('prefers file names that start with the query, then shorter paths', () => {
    const paths = ['src/components/Composer.tsx', 'src/hooks/useApp.ts', 'src/App.tsx', 'docs/app-notes/readme.md', 'x.ts'];
    expect(rankMentionCandidates(paths, 'app')).toEqual(['src/App.tsx', 'src/hooks/useApp.ts', 'docs/app-notes/readme.md']);
    expect(rankMentionCandidates(paths, '', 2)).toEqual(['x.ts', 'src/App.tsx']);
  });
});

describe('attachMentionedFiles', () => {
  // block body: ถ้าคืน mock ออกไป vitest จะถือว่าเป็น teardown แล้วเรียกมันหลังเทสต์
  beforeEach(() => {
    bridge.readFileLines.mockReset();
  });

  it('attaches readable files and skips missing, secret or denied ones', async () => {
    bridge.readFileLines.mockImplementation(async (path: string) => {
      if (path.endsWith('App.tsx')) return slice('1\tconst a = 1;', 1);
      if (path.endsWith('.env')) throw new Error('SENSITIVE_FILE: .env');
      throw new Error('not found');
    });
    const rules = [{ id: 'r', action: 'deny' as const, tool: 'read' as const, pattern: 'secret/*' }];
    const res = await attachMentionedFiles('ดู @src/App.tsx @.env @nope.ts @secret/key.txt', 'D:\\proj', rules);
    expect(res.files).toEqual(['src/App.tsx']);
    expect(res.block).toContain('<file path="src/App.tsx" lines="1-1 of 1">\n1\tconst a = 1;\n</file>');
    // กฎ deny ต้องไม่ถูกอ่านเลย
    expect(bridge.readFileLines).not.toHaveBeenCalledWith(expect.stringContaining('secret'), expect.anything(), expect.anything(), expect.anything());
    // ไฟล์ลับอ่านแบบไม่อนุญาตไฟล์ลับเสมอ
    expect(bridge.readFileLines).toHaveBeenCalledWith('D:\\proj/.env', 'D:\\proj', false, expect.any(Object));
  });

  it('tells the agent how to read the rest of a long file', async () => {
    bridge.readFileLines.mockResolvedValue(slice('1\ta', 400, 5000));
    const res = await attachMentionedFiles('@big.log', 'D:\\proj', []);
    expect(res.block).toContain('lines="1-400 of 5000"');
    expect(res.block).toContain('offset=401');
  });

  it('does nothing without mentions or a workspace', async () => {
    expect(await attachMentionedFiles('no mentions here', 'D:\\proj', [])).toEqual({ block: '', files: [] });
    expect(await attachMentionedFiles('@a.ts', '', [])).toEqual({ block: '', files: [] });
    expect(bridge.readFileLines).not.toHaveBeenCalled();
  });

  it('stops attaching once the total budget is used', async () => {
    bridge.readFileLines.mockResolvedValue(slice('x'.repeat(24_000), 10));
    const res = await attachMentionedFiles('@a @b @c @d', 'D:\\proj', []);
    expect(res.files).toEqual(['a', 'b', 'c']);
    expect(res.block).toContain('<file path="d" omitted=');
  });
});
