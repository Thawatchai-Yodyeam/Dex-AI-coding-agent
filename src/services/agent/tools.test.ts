import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ApprovalDecision, PermissionRule, ToolCallRecord } from '../../types/agent';
import type { AgentCallbacks, PermissionStore } from './types';

const bridge = vi.hoisted(() => ({
  grepSearch: vi.fn(async () => [] as unknown[]),
  findFiles: vi.fn(async () => [] as string[]),
  replaceFileContent: vi.fn(async () => ({ success: true, message: 'ok' })),
  readFile: vi.fn(async () => 'file body'),
  writeFile: vi.fn(async () => 'saved'),
  snapshotFile: vi.fn(async (): Promise<string | null> => 'before'),
  executeCommand: vi.fn(async () => ({ success: true, exit_code: 0, stdout: 'ok', stderr: '' })),
  checkSecurity: vi.fn(async () => ({ safe: true, high_risk: false, is_read_only: false, has_chaining: false })),
}));
vi.mock('../tauriBridge', () => ({ tauriBridge: bridge }));

import { compactToolResult, executeTool, resolveWorkspacePath, toolResultToString } from './tools';

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
    expect(bridge.grepSearch).toHaveBeenCalledWith('foo', false, 20, 'D:\\proj');
  });

  it('falls back to defaults for missing or invalid values', async () => {
    await executeTool('grep_search', { query: 42, case_insensitive: 'yes', max_results: -3 }, settings, callbacks);
    expect(bridge.grepSearch).toHaveBeenCalledWith('42', true, 50, 'D:\\proj');
    await executeTool('grep_search', { query: 'q', max_results: 'abc' }, settings, callbacks);
    expect(bridge.grepSearch).toHaveBeenLastCalledWith('q', true, 50, 'D:\\proj');
  });

  it('floors fractional numbers and accepts camelCase aliases', async () => {
    await executeTool('grep_search', { search: 'bar', caseInsensitive: false, maxResults: 7.9 }, settings, callbacks);
    expect(bridge.grepSearch).toHaveBeenCalledWith('bar', false, 7, 'D:\\proj');
  });

  it('accepts aliases for replace_file_content and resolves the path', async () => {
    await executeTool(
      'replace_file_content',
      { filePath: 'src/a.ts', targetContent: 'old', replacementContent: 'new' },
      settings,
      callbacks
    );
    expect(bridge.replaceFileContent).toHaveBeenCalledWith('D:\\proj/src/a.ts', 'old', 'new', 'D:\\proj', false);
  });

  it('defaults find_files pattern to *', async () => {
    await executeTool('find_files', {}, settings, callbacks);
    expect(bridge.findFiles).toHaveBeenCalledWith('*', 'D:\\proj');
  });

  it('returns an error object for unknown tools and bridge failures instead of throwing', async () => {
    expect(await executeTool('nope', {}, settings, callbacks)).toEqual({ error: 'Unknown tool: nope' });
    bridge.readFile.mockRejectedValueOnce(new Error('denied'));
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
    bridge.readFile.mockRejectedValueOnce('SENSITIVE_FILE: secret');
    const res = await run('read_file', { path: '.env' });
    expect(approvals[0].approvalReason).toBe('sensitive_file');
    expect(approvals[0].suggestedRule).toEqual({ tool: 'read', pattern: '.env' });
    expect(bridge.readFile).toHaveBeenLastCalledWith('D:\\proj/.env', 'D:\\proj', true);
    expect(res).toEqual({ content: 'file body' });
  });

  it('does not read a sensitive file when the user rejects', async () => {
    const { run } = setup('reject');
    bridge.readFile.mockRejectedValueOnce('SENSITIVE_FILE: secret');
    const res = (await run('read_file', { path: '.env' })) as { error: string };
    expect(res.error).toMatch(/rejected/i);
    expect(bridge.readFile).toHaveBeenCalledTimes(1);
  });

  it('wildcard allow rules do not unlock sensitive files, exact ones do', async () => {
    const wildcard = setup('once', [rule('allow', 'read', '*')]);
    await wildcard.run('read_file', { path: 'a.ts' });
    expect(bridge.readFile).toHaveBeenLastCalledWith('D:\\proj/a.ts', 'D:\\proj', false);

    const exact = setup('once', [rule('allow', 'read', '.env')]);
    await exact.run('read_file', { path: '.env' });
    expect(bridge.readFile).toHaveBeenLastCalledWith('D:\\proj/.env', 'D:\\proj', true);
    expect(exact.approvals).toHaveLength(0);
  });

  it('deny read rules block reads and hide grep matches', async () => {
    const { run } = setup('once', [rule('deny', 'read', 'secrets/*')]);
    const res = (await run('read_file', { path: 'src/../secrets/a.txt' })) as { error: string };
    expect(res.error).toContain('secrets/*');
    expect(bridge.readFile).not.toHaveBeenCalled();

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
  const settings = { cwd: 'D:\proj', autoPilot: true, permissionRules: [] } as unknown as AppSettings;

  function setup() {
    const checkpoints: [string, string | null | undefined][] = [];
    const callbacks: AgentCallbacks = {
      onTextChunk: () => {},
      onToolStart: () => {},
      onToolUpdate: () => {},
      onRequestApproval: async () => 'once',
      onFileCheckpoint: (path, original) => checkpoints.push([path, original]),
    };
    return { checkpoints, run: (name: string, args: Record<string, any>) => executeTool(name, args, settings, callbacks) };
  }

  beforeEach(() => vi.clearAllMocks());

  it('snapshots the file before writing it', async () => {
    const { checkpoints, run } = setup();
    bridge.snapshotFile.mockResolvedValueOnce(null);
    await run('write_file', { path: 'new.ts', content: 'x' });
    expect(checkpoints).toEqual([['D:\proj/new.ts', null]]);
    expect(bridge.snapshotFile.mock.invocationCallOrder[0]).toBeLessThan(bridge.writeFile.mock.invocationCallOrder[0]);
  });

  it('snapshots before replace_file_content', async () => {
    const { checkpoints, run } = setup();
    await run('replace_file_content', { path: 'a.ts', target_content: 'a', replacement_content: 'b' });
    expect(checkpoints).toEqual([['D:\proj/a.ts', 'before']]);
  });

  it('still writes when the snapshot fails, but reports it as skipped', async () => {
    const { checkpoints, run } = setup();
    bridge.snapshotFile.mockRejectedValueOnce('not UTF-8');
    expect(await run('write_file', { path: 'bin.dat', content: 'x' })).toEqual({ message: 'saved' });
    expect(checkpoints).toEqual([['D:\proj/bin.dat', undefined]]);
  });

  it('asks for sensitive-file approval before snapshotting it', async () => {
    const { checkpoints, run } = setup();
    bridge.snapshotFile.mockRejectedValueOnce('SENSITIVE_FILE: secret');
    await run('write_file', { path: '.env', content: 'x' });
    expect(bridge.snapshotFile).toHaveBeenLastCalledWith('D:\proj/.env', 'D:\proj', true);
    expect(checkpoints).toEqual([['D:\proj/.env', 'before']]);
    expect(bridge.writeFile).toHaveBeenCalledTimes(1);
  });
});
