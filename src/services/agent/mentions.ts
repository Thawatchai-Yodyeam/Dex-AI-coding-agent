import type { PermissionRule } from '../../types/agent';
import { tauriBridge } from '../tauriBridge';
import { evaluateRules, relativeToWorkspace } from './permissions';
import { resolveWorkspacePath } from './tools';

/** `@path` ที่ต้นข้อความหรือหลังช่องว่าง (อีเมลอย่าง a@b.com ไม่นับ) */
const MENTION_RE = /(?:^|\s)@([^\s@"'`<>|]+)/g;
/** วรรคตอนท้ายประโยคที่ติดมากับพาธ เช่น "ดู @src/App.tsx, แล้ว..." */
const TRAILING_PUNCT = /[.,;:!?)\]}]+$/;

const MAX_MENTIONED_FILES = 10;
/** ต่อไฟล์ ~6k token — ไฟล์ยาวกว่านี้แนบแค่ส่วนต้น แล้วบอกให้ agent อ่านต่อเอง */
const MAX_CHARS_PER_FILE = 24_000;
const MAX_LINES_PER_FILE = 2000;
/** รวมทุกไฟล์ในข้อความเดียว */
const MAX_TOTAL_CHARS = 80_000;

/** พาธที่ผู้ใช้อ้างด้วย `@` (ไม่ซ้ำ ตามลำดับที่พิมพ์) */
export function extractMentions(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    const path = m[1].replace(TRAILING_PUNCT, '');
    if (path) seen.add(path);
    if (seen.size >= MAX_MENTIONED_FILES) break;
  }
  return [...seen];
}

/** คำที่กำลังพิมพ์หลัง `@` ตรงตำแหน่ง caret — null = ไม่ได้พิมพ์ mention อยู่ */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(?:^|\s)@([^\s@"'`<>|]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[1].length - 1, query: m[1] };
}

/** เรียงไฟล์ที่ค้นเจอ: ชื่อไฟล์ขึ้นต้นด้วยคำค้น > ชื่อไฟล์มีคำค้น > พาธมีคำค้น แล้วพาธสั้นก่อน */
export function rankMentionCandidates(paths: readonly string[], query: string, limit = 8): string[] {
  const q = query.toLowerCase();
  const score = (p: string) => {
    const lower = p.toLowerCase();
    const name = lower.slice(lower.lastIndexOf('/') + 1);
    if (!q) return 0;
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    return lower.includes(q) ? 2 : 3;
  };
  return [...paths]
    .map((p) => ({ p, s: score(p) }))
    .filter((x) => x.s < 3)
    .sort((a, b) => a.s - b.s || a.p.length - b.p.length || a.p.localeCompare(b.p))
    .slice(0, limit)
    .map((x) => x.p);
}

export interface MentionAttachment {
  /** ข้อความที่แนบไปกับ prompt ('' = ไม่มีไฟล์ที่แนบได้) */
  block: string;
  /** พาธ (relative) ที่แนบเนื้อหาแล้ว */
  files: string[];
}

/**
 * อ่านไฟล์ที่ผู้ใช้ `@` ถึง แล้วแนบเนื้อหาไปกับข้อความ — agent ไม่ต้องเสีย step ไปอ่านเอง
 * ข้ามเงียบ ๆ: ไม่ใช่ไฟล์ / ไม่มีอยู่ / นอก workspace / ไฟล์ลับ / โดนกฎ deny — `@path` ยังอยู่ในข้อความ
 * agent จึงอ่านเองได้ด้วย read_file (ซึ่งขออนุมัติตามปกติ)
 */
export async function attachMentionedFiles(
  text: string,
  cwd: string,
  rules: readonly PermissionRule[]
): Promise<MentionAttachment> {
  const mentions = cwd ? extractMentions(text) : [];
  if (mentions.length === 0) return { block: '', files: [] };

  const slices = await Promise.all(
    mentions.map(async (mention) => {
      const path = resolveWorkspacePath(cwd, mention);
      const rel = relativeToWorkspace(cwd, path);
      if (evaluateRules(rules, 'read', rel)?.action === 'deny') return null;
      try {
        const slice = await tauriBridge.readFileLines(path, cwd, false, {
          offset: 1,
          limit: MAX_LINES_PER_FILE,
          maxChars: MAX_CHARS_PER_FILE,
        });
        return { rel, slice };
      } catch {
        return null;
      }
    })
  );

  const parts: string[] = [];
  const files: string[] = [];
  let total = 0;
  for (const hit of slices) {
    if (!hit) continue;
    const { rel, slice } = hit;
    if (total + slice.content.length > MAX_TOTAL_CHARS) {
      parts.push(`<file path="${rel}" omitted="too much attached text — use read_file" />`);
      continue;
    }
    total += slice.content.length;
    files.push(rel);
    const range = slice.end_line === 0 ? 'empty' : `${slice.start_line}-${slice.end_line} of ${slice.total_lines}`;
    const more =
      slice.end_line > 0 && slice.end_line < slice.total_lines
        ? `\n[Only the first ${slice.end_line} lines are attached. Call read_file with offset=${slice.end_line + 1} for the rest.]`
        : '';
    parts.push(`<file path="${rel}" lines="${range}">\n${slice.content}${more}\n</file>`);
  }
  if (parts.length === 0) return { block: '', files: [] };
  return {
    block: `[The user referenced these workspace files with @. Their current contents are attached, line-numbered like read_file output.]
<mentioned_files>
${parts.join('\n')}
</mentioned_files>`,
    files,
  };
}
