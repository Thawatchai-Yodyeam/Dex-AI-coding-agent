import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ApprovalDecision, PermissionRule, ToolCallRecord } from '../../types/agent';
import { TOOL_IMAGES_KEY, type AgentCallbacks, type PermissionStore } from './types';

const { SLICE } = vi.hoisted(() => ({
  SLICE: { content: '     1\tfile body\n', start_line: 1, end_line: 1, total_lines: 1, truncated_lines: 0 },
}));
const bridge = vi.hoisted(() => ({
  grepSearch: vi.fn(async () => [] as unknown[]),
  findFiles: vi.fn(async () => [] as string[]),
  editFile: vi.fn(async () => ({ success: true, message: 'ok', occurrences: 1 })),
  readFileLines: vi.fn(async () => SLICE),
  writeFile: vi.fn(async () => 'saved'),
  snapshotFile: vi.fn(async (): Promise<string | null> => 'before'),
  executeCommand: vi.fn(async () => ({ success: true, exit_code: 0, stdout: 'ok', stderr: '' })),
  checkSecurity: vi.fn(async () => ({ safe: true, high_risk: false, is_read_only: false, has_chaining: false })),
  startBackgroundCommand: vi.fn(async () => 123),
  readBackgroundOutput: vi.fn(async () => ({ output: 'listening on 5173', dropped_bytes: 0, running: true, exit_code: null })),
  killCommand: vi.fn(async () => true),
  webFetch: vi.fn(),
}));
vi.mock('../tauriBridge', () => ({ tauriBridge: bridge }));

import {
  BACKGROUND_WARMUP_MS,
  clearWebCache,
  compactToolResult,
  executeTool,
  resolveWorkspacePath,
  runToolCalls,
  toolResultToString,
} from './tools';

const RANGE = { offset: 1, limit: 2000, maxChars: 32_000 };

describe('compactToolResult', () => {
  it('leaves short strings untouched', () => {
    expect(compactToolResult('short')).toBe('short');
  });

  it('keeps the head and tail of long strings', () => {
    const text = 'H'.repeat(10_000) + 'M'.repeat(5_000) + 'T'.repeat(5_000);
    const out = compactToolResult(text) as string;
    expect(out.startsWith('H'.repeat(8_400))).toBe(true);
    expect(out.endsWith('T'.repeat(3_600))).toBe(true);
    expect(out).toContain('[truncated 8000 of 20000 chars]');
    expect(out.length).toBeLessThan(text.length);
  });

  it('truncates content/stdout/stderr fields without mutating the input', () => {
    const long = 'x'.repeat(20_000);
    const input = { content: long, stdout: long, stderr: long, other: long, exit_code: 1 };
    const out = compactToolResult(input) as Record<string, unknown>;
    expect((out.content as string).length).toBeLessThan(long.length);
    expect((out.stdout as string).length).toBeLessThan(long.length);
    expect((out.stderr as string).length).toBeLessThan(long.length);
    expect(out.other).toBe(long);
    expect(out.exit_code).toBe(1);
    expect(input.content).toBe(long);
  });

  it('passes through non-string primitives', () => {
    expect(compactToolResult(null)).toBeNull();
    expect(compactToolResult(42)).toBe(42);
  });

  it('toolResultToString stringifies objects', () => {
    expect(toolResultToString({ a: 1 })).toBe('{"a":1}');
    expect(toolResultToString('plain')).toBe('plain');
  });
});

describe('resolveWorkspacePath', () => {
  it('returns cwd for empty input', () => {
    expect(resolveWorkspacePath('D:\\proj')).toBe('D:\\proj');
    expect(resolveWorkspacePath('D:\\proj', '   ')).toBe('D:\\proj');
  });

  it('keeps absolute paths as-is', () => {
    expect(resolveWorkspacePath('D:\\proj', 'C:\\other\\a.ts')).toBe('C:\\other\\a.ts');
    expect(resolveWorkspacePath('D:\\proj', 'C:/other/a.ts')).toBe('C:/other/a.ts');
    expect(resolveWorkspacePath('D:\\proj', '\\\\server\\share\\a')).toBe('\\\\server\\share\\a');
    expect(resolveWorkspacePath('/home/u', '/etc/hosts')).toBe('/etc/hosts');
  });

  it('joins relative paths onto cwd without doubled separators', () => {
    expect(resolveWorkspacePath('D:\\proj', 'src/a.ts')).toBe('D:\\proj/src/a.ts');
    expect(resolveWorkspacePath('D:\\proj\\', ' src\\a.ts ')).toBe('D:\\proj/src\\a.ts');
    expect(resolveWorkspacePath('D:/proj//', 'src')).toBe('D:/proj/src');
  });
});

describe('executeTool argument coercion', () => {
  const settings = { cwd: 'D:\\proj', autoPilot: true } as AppSettings;
  const callbacks: AgentCallbacks = {
    onTextChunk: () => {},
    onToolStart: () => {},
    onToolUpdate: () => {},
    onRequestApproval: async () => 'once',
  };

  beforeEach(() => vi.clearAllMocks());

  it('coerces string booleans and numbers for grep_search', async () => {
    await executeTool('grep_search', { query: 'foo', case_insensitive: 'false', max_results: '20' }, settings, callbacks);
    expect(bridge.grepSearch).toHaveBeenCalledWith('foo', false, 20, 'D:\\proj', { regex: false });
  });

  it('falls back to defaults for missing or invalid values', async () => {
    await executeTool('grep_search', { query: 42, case_insensitive: 'yes', max_results: -3 }, settings, callbacks);
    expect(bridge.grepSearch).toHaveBeenCalledWith('42', true, 50, 'D:\\proj', { regex: false });
    await executeTool('grep_search', { query: 'q', max_results: 'abc' }, settings, callbacks);
    expect(bridge.grepSearch).toHaveBeenLastCalledWith('q', true, 50, 'D:\\proj', { regex: false });
  });

  it('floors fractional numbers and accepts camelCase aliases', async () => {
    await executeTool('grep_search', { search: 'bar', caseInsensitive: false, maxResults: 7.9 }, settings, callbacks);
    expect(bridge.grepSearch).toHaveBeenCalledWith('bar', false, 7, 'D:\\proj', { regex: false });
  });

  it('accepts aliases for replace_file_content and resolves the path', async () => {
    await executeTool(
      'replace_file_content',
      { filePath: 'src/a.ts', targetContent: 'old', replacementContent: 'new' },
      settings,
      callbacks
    );
    expect(bridge.editFile).toHaveBeenCalledWith(
      'D:\\proj/src/a.ts',
      [{ target_content: 'old', replacement_content: 'new', replace_all: false }],
      'D:\\proj',
      false
    );
  });

  it('parses multi_edit_file edits, including a JSON string, and rejects empty lists', async () => {
    const edits = [{ targetContent: 'a', replacementContent: 'b', replace_all: 'true' }];
    await executeTool('multi_edit_file', { path: 'a.ts', edits: JSON.stringify(edits) }, settings, callbacks);
    expect(bridge.editFile).toHaveBeenCalledWith(
      'D:\\proj/a.ts',
      [{ target_content: 'a', replacement_content: 'b', replace_all: true }],
      'D:\\proj',
      false
    );
    const res = (await executeTool('multi_edit_file', { path: 'a.ts', edits: [] }, settings, callbacks)) as { error: string };
    expect(res.error).toMatch(/non-empty/);
  });

  it('pages read_file and tells the model how to continue', async () => {
    bridge.readFileLines.mockResolvedValueOnce({ ...SLICE, start_line: 1, end_line: 2000, total_lines: 5000 });
    const res = (await executeTool('read_file', { path: 'big.ts' }, settings, callbacks)) as { note: string };
    expect(res.note).toContain('offset=2001');
    await executeTool('read_file', { path: 'big.ts', offset: '2001', limit: 50 }, settings, callbacks);
    expect(bridge.readFileLines).toHaveBeenLastCalledWith('D:\\proj/big.ts', 'D:\\proj', false, {
      offset: 2001,
      limit: 50,
      maxChars: 32_000,
    });
  });

  it('passes regex and include through to grep only when used', async () => {
    await executeTool('grep_search', { query: 'fn \\w+', regex: true, include: '*.rs' }, settings, callbacks);
    expect(bridge.grepSearch).toHaveBeenCalledWith('fn \\w+', true, 50, 'D:\\proj', { regex: true, include: '*.rs' });
  });

  it('defaults find_files pattern to *', async () => {
    await executeTool('find_files', {}, settings, callbacks);
    expect(bridge.findFiles).toHaveBeenCalledWith('*', 'D:\\proj');
  });

  it('returns an error object for unknown tools and bridge failures instead of throwing', async () => {
    expect(await executeTool('nope', {}, settings, callbacks)).toEqual({ error: 'Unknown tool: nope' });
    bridge.readFileLines.mockRejectedValueOnce(new Error('denied'));
    expect(await executeTool('read_file', { path: 'x' }, settings, callbacks)).toEqual({ error: 'denied' });
  });
});

describe('executeTool permissions', () => {
  const base = { cwd: 'D:\\proj', autoPilot: true, permissionRules: [] } as unknown as AppSettings;
  const rule = (action: 'allow' | 'deny', tool: 'shell' | 'read' | 'edit', pattern: string) => ({
    id: `${action}-${pattern}`,
    action,
    tool,
    pattern,
  });

  function setup(decision: ApprovalDecision = 'once', rules: PermissionRule[] = []) {
    const approvals: ToolCallRecord[] = [];
    const added: { rule: Pick<PermissionRule, 'tool' | 'pattern'>; scope: string }[] = [];
    const callbacks: AgentCallbacks = {
      onTextChunk: () => {},
      onToolStart: () => {},
      onToolUpdate: () => {},
      onRequestApproval: async (tool) => {
        approvals.push(tool);
        return decision;
      },
    };
    const store: PermissionStore = { rules: () => rules, addRule: (r, scope) => added.push({ rule: r, scope }) };
    const run = (name: string, args: Record<string, any>, settings = base) =>
      executeTool(name, args, settings, callbacks, store);
    return { approvals, added, run };
  }

  beforeEach(() => vi.clearAllMocks());

  it('asks for non-read-only commands and offers a prefix rule', async () => {
    const { approvals, run } = setup();
    await run('run_shell_command', { command: 'npm test -- --watch' });
    expect(approvals).toHaveLength(1);
    expect(approvals[0].approvalReason).toBe('shell_command');
    expect(approvals[0].suggestedRule).toEqual({ tool: 'shell', pattern: 'npm test*' });
    expect(bridge.executeCommand).toHaveBeenCalled();
  });

  it('saves the suggested rule when the user picks "always"', async () => {
    const { added, run } = setup('always');
    await run('run_shell_command', { command: 'cargo check' });
    expect(added).toEqual([{ rule: { tool: 'shell', pattern: 'cargo check*' }, scope: 'always' }]);
  });

  it('runs allowed commands without asking, but never chained ones', async () => {
    const { approvals, run } = setup('once', [rule('allow', 'shell', 'npm test*')]);
    await run('run_shell_command', { command: 'npm test' });
    expect(approvals).toHaveLength(0);

    bridge.checkSecurity.mockResolvedValueOnce({ safe: true, high_risk: true, is_read_only: false, has_chaining: true });
    await run('run_shell_command', { command: 'npm test; rm -rf x' });
    expect(approvals).toHaveLength(1);
    expect(approvals[0].approvalReason).toBe('shell_chaining');
    expect(approvals[0].suggestedRule).toBeUndefined();
  });

  it('deny beats allow, including inside chained commands', async () => {
    const { run } = setup('once', [rule('allow', 'shell', 'git*'), rule('deny', 'shell', 'git push*')]);
    const res = (await run('run_shell_command', { command: 'git status && git push --force' })) as { error: string };
    expect(res.error).toContain('git push*');
    expect(bridge.executeCommand).not.toHaveBeenCalled();
  });

  it('asks before reading a sensitive file, then retries with permission', async () => {
    const { approvals, run } = setup();
    bridge.readFileLines.mockRejectedValueOnce('SENSITIVE_FILE: secret');
    const res = await run('read_file', { path: '.env' });
    expect(approvals[0].approvalReason).toBe('sensitive_file');
    expect(approvals[0].suggestedRule).toEqual({ tool: 'read', pattern: '.env' });
    expect(bridge.readFileLines).toHaveBeenLastCalledWith('D:\\proj/.env', 'D:\\proj', true, RANGE);
    expect(res).toEqual({ content: SLICE.content, start_line: 1, end_line: 1, total_lines: 1 });
  });

  it('does not read a sensitive file when the user rejects', async () => {
    const { run } = setup('reject');
    bridge.readFileLines.mockRejectedValueOnce('SENSITIVE_FILE: secret');
    const res = (await run('read_file', { path: '.env' })) as { error: string };
    expect(res.error).toMatch(/rejected/i);
    expect(bridge.readFileLines).toHaveBeenCalledTimes(1);
  });

  it('wildcard allow rules do not unlock sensitive files, exact ones do', async () => {
    const wildcard = setup('once', [rule('allow', 'read', '*')]);
    await wildcard.run('read_file', { path: 'a.ts' });
    expect(bridge.readFileLines).toHaveBeenLastCalledWith('D:\\proj/a.ts', 'D:\\proj', false, RANGE);

    const exact = setup('once', [rule('allow', 'read', '.env')]);
    await exact.run('read_file', { path: '.env' });
    expect(bridge.readFileLines).toHaveBeenLastCalledWith('D:\\proj/.env', 'D:\\proj', true, RANGE);
    expect(exact.approvals).toHaveLength(0);
  });

  it('deny read rules block reads and hide grep matches', async () => {
    const { run } = setup('once', [rule('deny', 'read', 'secrets/*')]);
    const res = (await run('read_file', { path: 'src/../secrets/a.txt' })) as { error: string };
    expect(res.error).toContain('secrets/*');
    expect(bridge.readFileLines).not.toHaveBeenCalled();

    bridge.grepSearch.mockResolvedValueOnce([
      { file: 'secrets/a.txt', line_number: 1, line_content: 'x' },
      { file: 'src/b.ts', line_number: 2, line_content: 'x' },
    ]);
    const grep = (await run('grep_search', { query: 'x' })) as { matches: { file: string }[] };
    expect(grep.matches.map((m) => m.file)).toEqual(['src/b.ts']);
  });

  it('edit allow rules skip the Supervised prompt', async () => {
    const supervised = { ...base, autoPilot: false } as AppSettings;
    const { approvals, run } = setup('once', [rule('allow', 'edit', 'src/*')]);
    await run('write_file', { path: 'src/a.ts', content: 'x' }, supervised);
    expect(approvals).toHaveLength(0);
    await run('write_file', { path: 'README.md', content: 'x' }, supervised);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].suggestedRule).toEqual({ tool: 'edit', pattern: 'README.md' });
  });
});

describe('executeTool file checkpoints', () => {
  const settings = { cwd: 'D:\\proj', autoPilot: true, permissionRules: [] } as unknown as AppSettings;

  function setup() {
    const checkpoints: [string, string | null | undefined][] = [];
    const sensitive: string[] = [];
    const callbacks: AgentCallbacks = {
      onTextChunk: () => {},
      onToolStart: () => {},
      onToolUpdate: () => {},
      onRequestApproval: async () => 'once',
      onFileCheckpoint: (path, original, isSensitive) => {
        checkpoints.push([path, original]);
        if (isSensitive) sensitive.push(path);
      },
    };
    return {
      checkpoints,
      sensitive,
      run: (name: string, args: Record<string, any>) => executeTool(name, args, settings, callbacks),
    };
  }

  beforeEach(() => vi.clearAllMocks());

  it('snapshots the file before writing it', async () => {
    const { checkpoints, run } = setup();
    bridge.snapshotFile.mockResolvedValueOnce(null);
    await run('write_file', { path: 'new.ts', content: 'x' });
    expect(checkpoints).toEqual([['D:\\proj/new.ts', null]]);
    expect(bridge.snapshotFile.mock.invocationCallOrder[0]).toBeLessThan(bridge.writeFile.mock.invocationCallOrder[0]);
  });

  it('snapshots before replace_file_content', async () => {
    const { checkpoints, run } = setup();
    await run('replace_file_content', { path: 'a.ts', target_content: 'a', replacement_content: 'b' });
    expect(checkpoints).toEqual([['D:\\proj/a.ts', 'before']]);
  });

  it('still writes when the snapshot fails, but reports it as skipped', async () => {
    const { checkpoints, run } = setup();
    bridge.snapshotFile.mockRejectedValueOnce('not UTF-8');
    expect(await run('write_file', { path: 'bin.dat', content: 'x' })).toEqual({ message: 'saved' });
    expect(checkpoints).toEqual([['D:\\proj/bin.dat', undefined]]);
  });

  it('asks for sensitive-file approval before snapshotting it', async () => {
    const { checkpoints, sensitive, run } = setup();
    // ครั้งแรกก่อนอนุมัติ และครั้งที่ลองแบบไม่แตะไฟล์ลับหลังอนุมัติ ต่างก็ถูกปฏิเสธ
    bridge.snapshotFile.mockRejectedValueOnce('SENSITIVE_FILE: secret').mockRejectedValueOnce('SENSITIVE_FILE: secret');
    await run('write_file', { path: '.env', content: 'x' });
    expect(bridge.snapshotFile).toHaveBeenLastCalledWith('D:\\proj/.env', 'D:\\proj', true);
    expect(checkpoints).toEqual([['D:\\proj/.env', 'before']]);
    expect(sensitive).toEqual(['D:\\proj/.env']);
    expect(bridge.writeFile).toHaveBeenCalledTimes(1);
  });

  it('does not mark an ordinary file as sensitive because an exact allow rule trusts it', async () => {
    const { checkpoints, sensitive } = setup();
    const trusting = { ...settings, permissionRules: [{ id: 'r', tool: 'edit', pattern: 'a.ts', action: 'allow' }] } as unknown as AppSettings;
    const callbacks: AgentCallbacks = {
      onTextChunk: () => {},
      onToolStart: () => {},
      onToolUpdate: () => {},
      onRequestApproval: async () => 'once',
      onFileCheckpoint: (path, original, isSensitive) => {
        checkpoints.push([path, original]);
        if (isSensitive) sensitive.push(path);
      },
    };
    await executeTool('write_file', { path: 'a.ts', content: 'x' }, trusting, callbacks);
    expect(checkpoints).toEqual([['D:\\proj/a.ts', 'before']]);
    expect(sensitive).toEqual([]);
  });
});

describe('runToolCalls', () => {
  it('runs adjacent read-only tools together and others one by one, keeping order', async () => {
    const events: string[] = [];
    const calls = ['read_file', 'grep_search', 'write_file', 'read_file'].map((name, i) => ({ name, i }));
    const results = await runToolCalls(
      calls,
      (c) => c.name,
      async (c) => {
        events.push(`start ${c.i}`);
        await new Promise((r) => setTimeout(r, c.i === 0 ? 10 : 0));
        events.push(`end ${c.i}`);
        return c.i;
      }
    );
    expect(results).toEqual([0, 1, 2, 3]);
    // 0 กับ 1 เริ่มก่อนที่ 0 จะจบ; write_file (2) ต้องรอทั้งคู่จบก่อน
    expect(events.slice(0, 2)).toEqual(['start 0', 'start 1']);
    expect(events.indexOf('start 2')).toBeGreaterThan(events.indexOf('end 0'));
    expect(events.indexOf('start 3')).toBeGreaterThan(events.indexOf('end 2'));
  });
});

describe('shell timeouts and background commands', () => {
  const settings = { cwd: 'D:\\proj', autoPilot: true, permissionRules: [] } as unknown as AppSettings;
  const callbacks: AgentCallbacks = {
    onTextChunk: () => {},
    onToolStart: () => {},
    onToolUpdate: () => {},
    onRequestApproval: async () => 'once',
  };

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('passes a clamped timeout to the foreground command', async () => {
    await executeTool('run_shell_command', { command: 'cargo build', timeout_secs: 600 }, settings, callbacks);
    expect(bridge.executeCommand).toHaveBeenLastCalledWith(expect.any(String), 'cargo build', 'D:\\proj', 600);
    await executeTool('run_shell_command', { command: 'cargo build', timeout_secs: 99_999 }, settings, callbacks);
    expect(bridge.executeCommand).toHaveBeenLastCalledWith(expect.any(String), 'cargo build', 'D:\\proj', 1800);
    await executeTool('run_shell_command', { command: 'npm test' }, settings, callbacks);
    expect(bridge.executeCommand).toHaveBeenLastCalledWith(expect.any(String), 'npm test', 'D:\\proj', 120);
  });

  it('starts background commands and returns their first output', async () => {
    vi.useFakeTimers();
    const pending = executeTool('run_shell_command', { command: 'npm run dev', run_in_background: true }, settings, callbacks);
    await vi.advanceTimersByTimeAsync(BACKGROUND_WARMUP_MS);
    const res = (await pending) as { background_id: string; running: boolean; stdout: string };
    expect(bridge.startBackgroundCommand).toHaveBeenCalledWith(res.background_id, 'npm run dev', 'D:\\proj');
    expect(bridge.executeCommand).not.toHaveBeenCalled();
    expect(res).toMatchObject({ running: true, stdout: 'listening on 5173' });
  });

  it('stops a running background command but not an unknown id', async () => {
    expect(await executeTool('stop_background_command', { id: 'tool-1' }, settings, callbacks)).toMatchObject({ stopped: true });
    expect(bridge.killCommand).toHaveBeenCalledWith('tool-1');

    bridge.readBackgroundOutput.mockRejectedValueOnce(new Error('ไม่พบคำสั่งเบื้องหลัง id nope'));
    const res = (await executeTool('stop_background_command', { id: 'nope' }, settings, callbacks)) as { error: string };
    expect(res.error).toContain('nope');
    expect(bridge.killCommand).toHaveBeenCalledTimes(1);
  });
});

describe('update_todos', () => {
  const settings = { cwd: 'D:\\proj', autoPilot: true, permissionRules: [] } as unknown as AppSettings;
  const callbacks: AgentCallbacks = {
    onTextChunk: () => {},
    onToolStart: () => {},
    onToolUpdate: () => {},
    onRequestApproval: async () => 'once',
  };

  it('normalises the list and summarises progress for the model', async () => {
    const updates: ToolCallRecord[] = [];
    const res = await executeTool(
      'update_todos',
      { todos: JSON.stringify([{ content: ' Read code ', status: 'completed' }, { title: 'Fix bug', status: 'doing' }, { content: '' }]) },
      settings,
      { ...callbacks, onToolUpdate: (t) => updates.push(t) }
    );
    expect(res).toEqual({ message: 'Todo list updated: 1 completed, 0 in progress, 1 pending.' });
    expect(updates.at(-1)?.args.todos).toEqual([
      { content: 'Read code', status: 'completed' },
      { content: 'Fix bug', status: 'pending' },
    ]);
    expect(await executeTool('update_todos', { todos: [] }, settings, callbacks)).toMatchObject({ error: expect.any(String) });
  });
});

describe('shell snapshot hook', () => {
  it('runs before commands that may change files, never for read-only ones', async () => {
    const settings = { cwd: 'D:/proj', autoPilot: true, permissionRules: [] } as unknown as AppSettings;
    const order: string[] = [];
    const callbacks: AgentCallbacks = {
      onTextChunk: () => {},
      onToolStart: () => {},
      onToolUpdate: () => {},
      onRequestApproval: async () => 'once',
      onBeforeShellCommand: async () => {
        order.push('snapshot');
      },
    };
    bridge.executeCommand.mockImplementation(async () => {
      order.push('run');
      return { success: true, exit_code: 0, stdout: '', stderr: '' };
    });
    bridge.checkSecurity.mockResolvedValueOnce({ safe: true, high_risk: false, is_read_only: true, has_chaining: false });
    await executeTool('run_shell_command', { command: 'git status' }, settings, callbacks);
    expect(order).toEqual(['run']);
    await executeTool('run_shell_command', { command: 'npm run format' }, settings, callbacks);
    expect(order).toEqual(['run', 'snapshot', 'run']);
  });
});

describe('web_fetch', () => {
  const settings = { cwd: 'D:\\proj', autoPilot: true, permissionRules: [] } as unknown as AppSettings;
  const page = (content: string, patch: Record<string, unknown> = {}) => ({
    url: 'https://docs.rs/regex/latest/regex/',
    status: 200,
    content_type: 'text/html',
    title: 'regex - Rust',
    content,
    truncated: false,
    redirect: null,
    ...patch,
  });

  function setup(decision: ApprovalDecision = 'once', rules: PermissionRule[] = []) {
    const approvals: ToolCallRecord[] = [];
    const added: Pick<PermissionRule, 'tool' | 'pattern'>[] = [];
    const callbacks: AgentCallbacks = {
      onTextChunk: () => {},
      onToolStart: () => {},
      onToolUpdate: () => {},
      onRequestApproval: async (tool) => {
        approvals.push(tool);
        return decision;
      },
    };
    const store: PermissionStore = { rules: () => rules, addRule: (r) => added.push(r) };
    const run = (args: Record<string, any>, signal?: AbortSignal) =>
      executeTool('web_fetch', args, settings, callbacks, store, { signal }) as Promise<any>;
    return { approvals, added, run };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearWebCache();
  });

  it('asks for each new domain, even in Auto-Pilot, and offers a domain rule', async () => {
    bridge.webFetch.mockResolvedValue(page('Install with cargo add regex'));
    const { approvals, added, run } = setup('session');
    const res = await run({ url: 'https://docs.rs/regex' });
    expect(approvals[0].approvalReason).toBe('web_fetch');
    expect(approvals[0].suggestedRule).toEqual({ tool: 'web', pattern: 'docs.rs' });
    expect(added).toEqual([{ tool: 'web', pattern: 'docs.rs' }]);
    expect(bridge.webFetch).toHaveBeenCalledWith('https://docs.rs/regex');
    expect(res).toMatchObject({ status: 200, title: 'regex - Rust', content: 'Install with cargo add regex' });
    expect(res.note).toMatch(/untrusted/);
  });

  it('follows allow and deny rules without asking', async () => {
    bridge.webFetch.mockResolvedValue(page('ok'));
    const allow = { id: 'a', action: 'allow' as const, tool: 'web' as const, pattern: '*.github.com' };
    const deny = { id: 'd', action: 'deny' as const, tool: 'web' as const, pattern: 'evil.example' };
    const { approvals, run } = setup('reject', [allow, deny]);
    expect(await run({ url: 'https://api.github.com/repos/x/y' })).toMatchObject({ content: 'ok' });
    expect(await run({ url: 'https://evil.example/?q=1' })).toMatchObject({ error: expect.stringContaining('evil.example') });
    expect(approvals).toEqual([]);
    expect(bridge.webFetch).toHaveBeenCalledTimes(1);
  });

  it('does not fetch when the user rejects', async () => {
    const { run } = setup('reject');
    expect(await run({ url: 'https://example.com' })).toMatchObject({ error: expect.stringMatching(/rejected/i) });
    expect(bridge.webFetch).not.toHaveBeenCalled();
  });

  it('pages through long content from the cache without asking again', async () => {
    const long = 'a'.repeat(20_000) + 'b'.repeat(5_000);
    bridge.webFetch.mockResolvedValue(page(long));
    const { approvals, run } = setup();
    const first = await run({ url: 'https://docs.rs/regex' });
    expect(first.content).toBe('a'.repeat(20_000));
    expect(first.note).toContain('offset=20000');
    const second = await run({ url: 'https://docs.rs/regex', offset: 20_000 });
    expect(second.content).toBe('b'.repeat(5_000));
    expect(second.note).not.toContain('offset=');
    expect(bridge.webFetch).toHaveBeenCalledTimes(1);
    expect(approvals).toHaveLength(1);
  });

  it('reports cross-domain redirects instead of following them', async () => {
    bridge.webFetch.mockResolvedValue(page('', { status: 302, redirect: 'https://other.example/login' }));
    const res = await setup().run({ url: 'https://short.link/x' });
    expect(res).toMatchObject({ status: 302, redirect: 'https://other.example/login' });
  });

  it('rejects URLs that are not http(s)', async () => {
    const { approvals, run } = setup();
    expect(await run({ url: 'file:///C:/Windows/win.ini' })).toMatchObject({ error: expect.stringContaining('http') });
    expect(await run({ url: 'not a url' })).toMatchObject({ error: expect.stringContaining('Invalid URL') });
    expect(approvals).toEqual([]);
    expect(bridge.webFetch).not.toHaveBeenCalled();
  });

  it('stops waiting when the turn is aborted', async () => {
    bridge.webFetch.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const pending = setup().run({ url: 'https://slow.example' }, controller.signal);
    await vi.waitFor(() => expect(bridge.webFetch).toHaveBeenCalled());
    controller.abort();
    expect(await pending).toMatchObject({ error: 'Cancelled by the user' });
  });
});

describe('browser tool', () => {
  const base = { cwd: 'D:\\proj', autoPilot: true, permissionRules: [], provider: 'anthropic' } as unknown as AppSettings;

  function setup(decision: ApprovalDecision = 'once', rules: PermissionRule[] = [], page = 'http://localhost:5173/') {
    const approvals: ToolCallRecord[] = [];
    const driver = {
      navigate: vi.fn(async () => null),
      currentUrl: vi.fn(async () => page),
      sleep: async () => {},
      cdp: vi.fn(async (method: string, params: any = {}) => {
        if (method === 'Page.captureScreenshot') return { data: 'SHOT' };
        const expr = String(params.expression ?? '');
        if (expr.startsWith('JSON.stringify({ width')) return { result: { value: JSON.stringify({ width: 800, height: 600, dpr: 1, scrollX: 0, scrollY: 0 }) } };
        if (expr.startsWith('JSON.stringify({ url')) return { result: { value: JSON.stringify({ url: page, title: 'App', ready: 'complete' }) } };
        return { result: { type: 'number', value: 1 } };
      }),
    };
    const callbacks: AgentCallbacks = {
      onTextChunk: () => {},
      onToolStart: () => {},
      onToolUpdate: () => {},
      onRequestApproval: async (tool) => {
        approvals.push(tool);
        return decision;
      },
    };
    const store: PermissionStore = { rules: () => rules, addRule: () => {} };
    const run = (args: Record<string, any>, settings = base) =>
      executeTool('browser', args, settings, callbacks, store, { browser: driver }) as Promise<any>;
    return { approvals, driver, run };
  }

  beforeEach(() => vi.clearAllMocks());

  it('opens localhost without asking in Auto-Pilot', async () => {
    const { approvals, driver, run } = setup();
    const res = await run({ action: 'navigate', url: 'http://localhost:5173' });
    expect(approvals).toEqual([]);
    expect(driver.navigate).toHaveBeenCalledWith('http://localhost:5173/');
    expect(res).toMatchObject({ title: 'App', note: expect.stringMatching(/untrusted/) });
  });

  it('asks before other sites, and before localhost when supervised', async () => {
    const { approvals, run } = setup();
    await run({ action: 'navigate', url: 'https://example.com/docs' });
    expect(approvals[0].approvalReason).toBe('browser_open');
    expect(approvals[0].suggestedRule).toEqual({ tool: 'web', pattern: 'example.com' });
    await run({ action: 'navigate', url: 'http://127.0.0.1:3000' }, { ...base, autoPilot: false });
    expect(approvals).toHaveLength(2);
  });

  it('honours web rules and refuses non-http URLs', async () => {
    const deny = { id: 'd', action: 'deny' as const, tool: 'web' as const, pattern: 'localhost' };
    const { approvals, driver, run } = setup('once', [deny]);
    expect(await run({ action: 'navigate', url: 'http://localhost:5173' })).toMatchObject({ error: expect.stringContaining('localhost') });
    expect(await run({ action: 'navigate', url: 'file:///C:/secret.txt' })).toMatchObject({ error: expect.stringContaining('http') });
    expect(approvals).toEqual([]);
    expect(driver.navigate).not.toHaveBeenCalled();
  });

  it('asks before running scripts outside localhost', async () => {
    const local = setup();
    await local.run({ action: 'evaluate', expression: '1' });
    expect(local.approvals).toEqual([]);

    const remote = setup('reject', [], 'https://bank.example/');
    expect(await remote.run({ action: 'evaluate', expression: 'document.cookie' })).toMatchObject({ error: expect.stringMatching(/rejected/i) });
    expect(remote.approvals[0].approvalReason).toBe('browser_script');
    expect(remote.driver.cdp).not.toHaveBeenCalled();
  });

  it('only takes screenshots for models that can see images', async () => {
    const { run } = setup();
    expect((await run({ action: 'screenshot' }))[TOOL_IMAGES_KEY]).toEqual([{ mediaType: 'image/jpeg', data: 'SHOT' }]);
    expect(await run({ action: 'screenshot' }, { ...base, provider: 'deepseek' })).toMatchObject({ error: expect.stringMatching(/snapshot/) });
  });

  it('rejects unknown actions', async () => {
    expect(await setup().run({ action: 'hover' })).toMatchObject({ error: expect.stringContaining('Unknown browser action') });
  });
});
