import type { ApprovalReason, AppSettings, PermissionRule, PermissionTool, ToolCallRecord } from '../../types/agent';
import { tauriBridge } from '../tauriBridge';
import { evaluateRules, isSensitiveFileError, relativeToWorkspace, suggestShellPattern } from './permissions';
import type { AgentCallbacks, PermissionStore } from './types';

/**
 * แหล่งเดียวของ tool schema (JSON Schema) — provider ทุกตัวแปลงจากตรงนี้
 * เพิ่ม/แก้ tool ที่เดียว ไม่ต้องตามแก้ใน driver แต่ละตัว
 */
export const TOOL_DEFINITIONS = [
  {
    name: 'run_shell_command',
    description:
      'Run a PowerShell command on Windows in the current workspace directory. Read-only commands may run automatically; anything that modifies the system asks the user first.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command, e.g. `git status`, `npm test`' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the full text content of a file in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace or absolute inside it' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create a new file or overwrite an entire file. Prefer replace_file_content to edit an existing file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write' },
        content: { type: 'string', description: 'Complete file contents' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and folders in a directory (leave path empty for the workspace root).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list' },
      },
    },
  },
  {
    name: 'replace_file_content',
    description:
      'Surgically edit a file: replace exactly one occurrence of target_content with replacement_content. target_content must match the file byte-for-byte (including whitespace) and be unique. Prefer this over write_file for edits.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to edit' },
        target_content: { type: 'string', description: 'Existing text to replace (must be unique in the file)' },
        replacement_content: { type: 'string', description: 'New text' },
      },
      required: ['path', 'target_content', 'replacement_content'],
    },
  },
  {
    name: 'grep_search',
    description:
      'Search all text files in the workspace for a plain substring (not a regex). Skips node_modules, target, dist, .git and files over 2 MB.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to search for' },
        case_insensitive: { type: 'boolean', description: 'Ignore case (default true)' },
        max_results: { type: 'number', description: 'Maximum matches to return (default 50)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_files',
    description: 'Find files by extension (`*.tsx`) or by a substring of their relative path (`Header`, `src/hooks`).',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'e.g. *.ts, App.css, components/' },
      },
      required: ['pattern'],
    },
  },
] as const;

export type ToolName = (typeof TOOL_DEFINITIONS)[number]['name'];

const MAX_TOOL_RESULT_CHARS = 12_000;

/** ตัดข้อความยาวแบบเก็บทั้งหัวและท้าย (error มักอยู่ท้าย output) */
function truncateMiddle(text: string, max = MAX_TOOL_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n... [truncated ${text.length - max} of ${text.length} chars] ...\n\n${text.slice(-tail)}`;
}

export function compactToolResult(result: unknown): unknown {
  if (typeof result === 'string') return truncateMiddle(result);
  if (result && typeof result === 'object') {
    const copy: Record<string, unknown> = { ...(result as Record<string, unknown>) };
    for (const key of ['content', 'stdout', 'stderr']) {
      if (typeof copy[key] === 'string') copy[key] = truncateMiddle(copy[key] as string);
    }
    return copy;
  }
  return result;
}

export function toolResultToString(result: unknown): string {
  const compacted = compactToolResult(result);
  return typeof compacted === 'string' ? compacted : JSON.stringify(compacted);
}

export function isToolError(result: unknown): boolean {
  return !!result && typeof result === 'object' && 'error' in (result as object);
}

export function resolveWorkspacePath(cwd: string, inputPath?: string): string {
  if (!inputPath || !inputPath.trim()) return cwd;
  const trimmed = inputPath.trim();
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\') || trimmed.startsWith('/')) {
    return trimmed;
  }
  const base = cwd.replace(/[\\/]+$/, '');
  const rel = trimmed.replace(/^[\\/]+/, '');
  return `${base}/${rel}`;
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : v == null ? fallback : String(v));
const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : fallback;
const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

interface ToolEnv {
  settings: AppSettings;
  record: ToolCallRecord;
  callbacks: AgentCallbacks;
  permissions: PermissionStore;
}

type Suggestion = Pick<PermissionRule, 'tool' | 'pattern'>;

/**
 * ขออนุมัติจากผู้ใช้ — คืน error object ถ้าถูกปฏิเสธ หรือ null ถ้าไปต่อได้
 * ถ้าผู้ใช้เลือก "ตลอดแชทนี้"/"อนุญาตเสมอ" จะบันทึก suggestion เป็นกฎ
 */
async function requireApproval(
  env: ToolEnv,
  rejectedMsg: string,
  reason: ApprovalReason,
  suggestion?: Suggestion
): Promise<{ error: string } | null> {
  env.record.status = 'pending_approval';
  env.record.approvalReason = reason;
  env.record.suggestedRule = suggestion;
  env.callbacks.onToolUpdate({ ...env.record });
  const decision = await env.callbacks.onRequestApproval({ ...env.record });
  env.record.approvalReason = undefined;
  env.record.suggestedRule = undefined;
  if (decision === 'reject') {
    env.record.status = 'rejected';
    env.record.error = rejectedMsg;
    return { error: rejectedMsg };
  }
  if ((decision === 'session' || decision === 'always') && suggestion) {
    env.permissions.addRule(suggestion, decision);
  }
  return null;
}

function markRunning(env: ToolEnv) {
  env.record.status = 'running';
  env.callbacks.onToolUpdate({ ...env.record });
}

function blockedByRule(env: ToolEnv, rule: PermissionRule): { error: string } {
  env.record.status = 'failed';
  env.record.error = `Blocked by permission rule (deny ${rule.tool}: ${rule.pattern})`;
  return { error: env.record.error };
}

/**
 * ตรวจกฎของไฟล์ — คืน error ถ้าโดน deny
 * `trustSensitive` = กฎ allow ที่ระบุไฟล์ตรงตัว (ไม่มี `*`) ซึ่งถือว่าผู้ใช้ตั้งใจให้แตะไฟล์ลับนั้น
 * ส่วนกฎ wildcard อย่าง `src/*` ไม่ข้ามการป้องกันไฟล์ลับ
 */
function checkFileRules(env: ToolEnv, tool: PermissionTool, path: string) {
  const rel = relativeToWorkspace(env.settings.cwd, path);
  const verdict = evaluateRules(env.permissions.rules(), tool, rel);
  if (verdict?.action === 'deny') return { rel, denied: blockedByRule(env, verdict.rule) };
  const allowed = verdict?.action === 'allow';
  return { rel, denied: null, allowed, trustSensitive: allowed && !verdict!.rule.pattern.includes('*') };
}

type GuardedResult<T> = { ok: true; value: T } | { ok: false; error: { error: string } };

/** รัน op แบบไม่แตะไฟล์ลับก่อน ถ้าฝั่ง Rust บอกว่าเป็นไฟล์ลับ → ขออนุมัติแล้วลองใหม่ */
async function withSensitiveRetry<T>(
  env: ToolEnv,
  op: (allowSensitive: boolean) => Promise<T>,
  trusted: boolean,
  suggestion: Suggestion,
  rejectedMsg: string
): Promise<GuardedResult<T>> {
  try {
    return { ok: true, value: await op(trusted) };
  } catch (err) {
    if (trusted || !isSensitiveFileError(err)) throw err;
    const rejected = await requireApproval(env, rejectedMsg, 'sensitive_file', suggestion);
    if (rejected) return { ok: false, error: rejected };
    markRunning(env);
    return { ok: true, value: await op(true) };
  }
}

/** จำเนื้อหาเดิมก่อนเขียนทับ ให้ UI ย้อนกลับได้ — เก็บไม่ได้ก็ยังเขียนต่อ (แค่ undo ไฟล์นั้นไม่ได้) */
async function checkpointBeforeWrite(env: ToolEnv, path: string, allowSensitive: boolean) {
  if (!env.callbacks.onFileCheckpoint) return;
  let original: string | null | undefined;
  try {
    original = await tauriBridge.snapshotFile(path, env.settings.cwd, allowSensitive);
  } catch (err) {
    // ไฟล์ลับที่ยังไม่ได้อนุญาต → ปล่อยให้ op จริงโยน SENSITIVE_FILE เพื่อเข้าขั้นขออนุมัติ
    if (isSensitiveFileError(err)) throw err;
    original = undefined;
  }
  env.callbacks.onFileCheckpoint(path, original);
}

type ToolHandler = (args: Record<string, any>, env: ToolEnv) => Promise<unknown>;

const HANDLERS: Record<ToolName, ToolHandler> = {
  async run_shell_command(args, env) {
    const cmd = str(args.command);
    const sec = await tauriBridge.checkSecurity(cmd, env.settings.cwd);
    if (!sec.safe) {
      env.record.status = 'failed';
      env.record.error = sec.reason || 'Command blocked as high risk';
      return { error: env.record.error };
    }
    const verdict = evaluateRules(env.permissions.rules(), 'shell', cmd);
    if (verdict?.action === 'deny') return blockedByRule(env, verdict.rule);
    // กฎ allow ใช้ไม่ได้กับคำสั่งที่ต่อกันหลายท่อน — `npm test*` ต้องไม่ปล่อย `npm test; rm -rf x`
    const allowedByRule = verdict?.action === 'allow' && !sec.has_chaining;
    const needsApproval = !allowedByRule && (!env.settings.autoPilot || !sec.is_read_only || sec.high_risk);
    if (needsApproval) {
      const reason: ApprovalReason = sec.has_chaining
        ? 'shell_chaining'
        : sec.high_risk
          ? 'shell_risky'
          : !sec.is_read_only
            ? 'shell_command'
            : 'supervised';
      const suggestion = sec.has_chaining ? undefined : { tool: 'shell' as const, pattern: suggestShellPattern(cmd) };
      const rejected = await requireApproval(env, 'User rejected command execution', reason, suggestion);
      if (rejected) return rejected;
    }
    markRunning(env);
    const res = await tauriBridge.executeCommand(env.record.id, cmd, env.settings.cwd);
    env.record.output = res.stdout + (res.stderr ? `\n[STDERR]: ${res.stderr}` : '');
    env.record.exitCode = res.exit_code;
    env.record.status = res.success ? 'completed' : 'failed';
    return { stdout: res.stdout, stderr: res.stderr, exit_code: res.exit_code, success: res.success };
  },

  async read_file(args, env) {
    const path = resolveWorkspacePath(env.settings.cwd, str(args.path));
    env.record.args.path = path;
    const guard = checkFileRules(env, 'read', path);
    if (guard.denied) return guard.denied;
    markRunning(env);
    const res = await withSensitiveRetry(
      env,
      (ok) => tauriBridge.readFile(path, env.settings.cwd, ok),
      guard.trustSensitive,
      { tool: 'read', pattern: guard.rel },
      'User rejected reading a sensitive file'
    );
    if (!res.ok) return res.error;
    env.record.output = `${res.value.length.toLocaleString()} chars`;
    env.record.status = 'completed';
    return { content: res.value };
  },

  async write_file(args, env) {
    const path = resolveWorkspacePath(env.settings.cwd, str(args.path));
    env.record.args.path = path;
    const guard = checkFileRules(env, 'edit', path);
    if (guard.denied) return guard.denied;
    const suggestion = { tool: 'edit' as const, pattern: guard.rel };
    if (!guard.allowed && !env.settings.autoPilot) {
      const rejected = await requireApproval(env, 'User rejected file write', 'supervised', suggestion);
      if (rejected) return rejected;
    }
    markRunning(env);
    const res = await withSensitiveRetry(
      env,
      async (ok) => {
        await checkpointBeforeWrite(env, path, ok);
        return tauriBridge.writeFile(path, str(args.content), env.settings.cwd, ok);
      },
      guard.trustSensitive,
      suggestion,
      'User rejected writing a sensitive file'
    );
    if (!res.ok) return res.error;
    env.record.output = res.value;
    env.record.status = 'completed';
    return { message: res.value };
  },

  async list_directory(args, env) {
    markRunning(env);
    const path = resolveWorkspacePath(env.settings.cwd, str(args.path));
    env.record.args.path = path;
    const entries = await tauriBridge.listDir(path, env.settings.cwd);
    env.record.output = `${entries.length} entries`;
    env.record.status = 'completed';
    return { entries };
  },

  async replace_file_content(args, env) {
    const path = resolveWorkspacePath(env.settings.cwd, str(args.path ?? args.filePath ?? args.file));
    const target = str(args.target_content ?? args.targetContent);
    const replacement = str(args.replacement_content ?? args.replacementContent);
    Object.assign(env.record.args, { path, target_content: target, replacement_content: replacement });
    const guard = checkFileRules(env, 'edit', path);
    if (guard.denied) return guard.denied;
    const suggestion = { tool: 'edit' as const, pattern: guard.rel };
    if (!guard.allowed && !env.settings.autoPilot) {
      const rejected = await requireApproval(env, 'User rejected file modification', 'supervised', suggestion);
      if (rejected) return rejected;
    }
    markRunning(env);
    const guarded = await withSensitiveRetry(
      env,
      async (ok) => {
        await checkpointBeforeWrite(env, path, ok);
        return tauriBridge.replaceFileContent(path, target, replacement, env.settings.cwd, ok);
      },
      guard.trustSensitive,
      suggestion,
      'User rejected modifying a sensitive file'
    );
    if (!guarded.ok) return guarded.error;
    const res = guarded.value;
    env.record.output = res.message;
    env.record.status = res.success ? 'completed' : 'failed';
    return res;
  },

  async grep_search(args, env) {
    markRunning(env);
    const query = str(args.query ?? args.search ?? args.term);
    const matches = await tauriBridge.grepSearch(
      query,
      bool(args.case_insensitive ?? args.caseInsensitive, true),
      num(args.max_results ?? args.maxResults, 50),
      env.settings.cwd
    );
    // ไฟล์ลับถูกข้ามตั้งแต่ฝั่ง Rust แล้ว ที่นี่ตัดไฟล์ที่ผู้ใช้ตั้งกฎ deny read ไว้
    const rules = env.permissions.rules();
    const visible = matches.filter((m) => evaluateRules(rules, 'read', m.file)?.action !== 'deny');
    env.record.output = `${visible.length} matches`;
    env.record.status = 'completed';
    return { matches: visible };
  },

  async find_files(args, env) {
    markRunning(env);
    const files = await tauriBridge.findFiles(str(args.pattern ?? args.query, '*'), env.settings.cwd);
    env.record.output = `${files.length} files`;
    env.record.status = 'completed';
    return { files };
  },
};

/**
 * รัน tool หนึ่งตัวพร้อม guard (security check + approval) และรายงานสถานะผ่าน callbacks
 * ไม่ throw — error ทุกชนิดถูกคืนเป็น `{ error }` เพื่อส่งกลับให้โมเดลรับรู้
 */
export async function executeTool(
  name: string,
  args: Record<string, any>,
  settings: AppSettings,
  callbacks: AgentCallbacks,
  permissions: PermissionStore = { rules: () => settings.permissionRules ?? [], addRule: () => {} }
): Promise<unknown> {
  const record: ToolCallRecord = {
    id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    args: { ...args },
    status: 'running',
  };
  callbacks.onToolStart({ ...record });
  const env: ToolEnv = { settings, record, callbacks, permissions };

  let result: unknown;
  const handler = HANDLERS[name as ToolName];
  try {
    if (!handler) {
      record.status = 'failed';
      record.error = `Unknown tool: ${name}`;
      result = { error: record.error };
    } else {
      result = await handler(args, env);
    }
  } catch (err: any) {
    record.status = 'failed';
    record.error = err?.message || String(err);
    result = { error: record.error };
  }

  callbacks.onToolUpdate({ ...record });
  return result;
}
