import type { PermissionRule, PermissionTool } from '../../types/agent';

/** prefix ของ error จากฝั่ง Rust เมื่อแตะไฟล์ลับโดยยังไม่ได้รับอนุญาต (ดู SENSITIVE_PREFIX ใน lib.rs) */
export const SENSITIVE_ERROR_PREFIX = 'SENSITIVE_FILE:';

export function isSensitiveFileError(err: unknown): boolean {
  const msg = typeof err === 'string' ? err : (err as any)?.message;
  return typeof msg === 'string' && msg.startsWith(SENSITIVE_ERROR_PREFIX);
}

/** ยุบ whitespace ให้เหลือช่องเดียว — `npm  test` กับ `npm test` ต้องเข้ากฎเดียวกัน */
export function normalizeCommand(cmd: string): string {
  return cmd.trim().split(/\s+/).join(' ');
}

/** พาธเทียบกับ workspace แบบ `src/App.tsx` (ยุบ `.`/`..` แล้ว) — นอก workspace คืนพาธเต็ม */
export function relativeToWorkspace(cwd: string, path: string): string {
  const parts: string[] = [];
  for (const seg of path.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const full = parts.join('/');
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (root && full.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return full.slice(root.length + 1);
  return full;
}

function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`, 'i');
}

/** subject ของ shell = คำสั่ง (normalize แล้ว), ของไฟล์ = พาธสัมพัทธ์ใน workspace */
export function ruleMatches(rule: Pick<PermissionRule, 'tool' | 'pattern'>, tool: PermissionTool, subject: string): boolean {
  const pattern = rule.pattern.trim();
  if (rule.tool !== tool || !pattern) return false;
  if (tool === 'shell') return globToRegExp(normalizeCommand(pattern)).test(normalizeCommand(subject));
  // ชื่อ tool ของ MCP เช่น `mcp__github__create_issue` หรือ `mcp__github__*`
  if (tool === 'mcp') return globToRegExp(pattern).test(subject);
  const re = globToRegExp(pattern.replace(/\\/g, '/').replace(/^\.\//, ''));
  const rel = subject.replace(/\\/g, '/');
  // pattern ที่ไม่มี `/` เทียบชื่อไฟล์ได้ด้วย — `.env*` จับ `config/.env.local`
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  return re.test(rel) || (!pattern.includes('/') && re.test(name));
}

/** แยกคำสั่งที่ต่อกันด้วย `;` `&&` `||` `|` หรือขึ้นบรรทัดใหม่ — ใช้กับกฎ deny ให้จับได้ทุกท่อน */
function shellSegments(cmd: string): string[] {
  return [cmd, ...cmd.split(/[;&|\r\n]+/).map((s) => s.trim()).filter(Boolean)];
}

/** deny ชนะ allow เสมอ ไม่ว่ากฎจะเรียงลำดับแบบไหน */
export function evaluateRules(
  rules: readonly PermissionRule[],
  tool: PermissionTool,
  subject: string
): { action: 'allow' | 'deny'; rule: PermissionRule } | null {
  const denySubjects = tool === 'shell' ? shellSegments(subject) : [subject];
  const deny = rules.find((r) => r.action === 'deny' && denySubjects.some((s) => ruleMatches(r, tool, s)));
  if (deny) return { action: 'deny', rule: deny };
  const allow = rules.find((r) => r.action === 'allow' && ruleMatches(r, tool, subject));
  return allow ? { action: 'allow', rule: allow } : null;
}

const SUBCOMMAND_RUNNERS = ['run', 'exec', 'x', 'dlx'];

/**
 * กฎที่เสนอให้ตอนกด "อนุญาตเสมอ": คำสั่งหลัก + subcommand แล้วตามด้วย `*`
 * `npm test -- --watch` → `npm test*`, `npm run build` → `npm run build*`
 */
export function suggestShellPattern(cmd: string): string {
  const tokens = normalizeCommand(cmd).split(' ').filter(Boolean);
  const prefix: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('-')) break;
    prefix.push(token);
    const limit = SUBCOMMAND_RUNNERS.includes(prefix[1]?.toLowerCase()) ? 3 : 2;
    if (prefix.length >= limit) break;
  }
  return `${prefix.join(' ')}*`;
}

export function newRuleId(): string {
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
