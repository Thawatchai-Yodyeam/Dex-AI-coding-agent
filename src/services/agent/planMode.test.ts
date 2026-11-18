import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../types/agent';
import type { AgentCallbacks } from './types';

const bridge = vi.hoisted(() => ({
  writeFile: vi.fn(async () => 'saved'),
  snapshotFile: vi.fn(async (): Promise<string | null> => 'before'),
  editFile: vi.fn(async () => ({ success: true, message: 'ok', occurrences: 1 })),
  readFileLines: vi.fn(async () => ({ content: '     1\tx\n', start_line: 1, end_line: 1, total_lines: 1, truncated_lines: 0 })),
  executeCommand: vi.fn(async () => ({ success: true, exit_code: 0, stdout: 'ok', stderr: '' })),
  checkSecurity: vi.fn(async () => ({ safe: true, high_risk: false, is_read_only: true, has_chaining: false })),
  startBackgroundCommand: vi.fn(async () => 1),
  readBackgroundOutput: vi.fn(async () => ({ output: '', dropped_bytes: 0, running: true, exit_code: null })),
}));
vi.mock('../tauriBridge', () => ({ tauriBridge: bridge }));

import {
  PLAN_APPROVED_NOTE,
  PLAN_MODE_BLOCKED,
  PLAN_MODE_NOTE,
  PLAN_MODE_OFF_NOTE,
  blockedInPlanMode,
  planModeNote,
} from './planMode';
import { TOOL_DEFINITIONS, executeTool } from './tools';

describe('blockedInPlanMode', () => {
  it('lets read-only tools through', () => {
    for (const name of ['read_file', 'list_directory', 'grep_search', 'find_files', 'read_background_output', 'update_todos', 'web_fetch', 'use_skill']) {
      expect(blockedInPlanMode(name, {}), name).toBe(false);
    }
  });

  it('blocks tools that write', () => {
    for (const name of ['write_file', 'replace_file_content', 'multi_edit_file', 'stop_background_command']) {
      expect(blockedInPlanMode(name, {}), name).toBe(true);
    }
  });

  it('decides every built-in tool on purpose', () => {
    // tool ใหม่ที่ลืมใส่ในรายการจะถูกกันไว้ก่อน — เทสต์นี้กันไม่ให้ลืมตัดสินใจว่าควรเปิดให้ไหม
    const expected: Record<string, boolean> = {
      run_shell_command: false,
      read_background_output: false,
      stop_background_command: true,
      read_file: false,
      write_file: true,
      list_directory: false,
      replace_file_content: true,
      multi_edit_file: true,
      grep_search: false,
      update_todos: false,
      web_fetch: false,
      browser: true,
      docx: true,
      design: true,
      find_files: false,
    };
    expect(Object.keys(expected).sort()).toEqual(TOOL_DEFINITIONS.map((t) => t.name).sort());
    for (const [name, blocked] of Object.entries(expected)) expect(blockedInPlanMode(name, {}), name).toBe(blocked);
  });

  it('blocks background shell commands but leaves the rest to the security check', () => {
    expect(blockedInPlanMode('run_shell_command', { command: 'git status' })).toBe(false);
    expect(blockedInPlanMode('run_shell_command', { command: 'npm run dev', run_in_background: true })).toBe(true);
    expect(blockedInPlanMode('run_shell_command', { command: 'npm run dev', run_in_background: 'true' })).toBe(true);
    expect(blockedInPlanMode('run_shell_command', { command: 'npm run dev', background: true })).toBe(true);
  });

  it('allows only the viewing actions of multi-action tools', () => {
    expect(blockedInPlanMode('browser', { action: 'navigate' })).toBe(false);
    expect(blockedInPlanMode('browser', { action: ' snapshot ' })).toBe(false);
    expect(blockedInPlanMode('browser', { action: 'click' })).toBe(true);
    expect(blockedInPlanMode('browser', { action: 'type' })).toBe(true);
    expect(blockedInPlanMode('browser', { action: 'evaluate' })).toBe(true);
    expect(blockedInPlanMode('docx', { action: 'read' })).toBe(false);
    expect(blockedInPlanMode('docx', { action: 'open' })).toBe(false);
    expect(blockedInPlanMode('docx', { action: 'open', discard: true })).toBe(true);
    expect(blockedInPlanMode('docx', { action: 'save' })).toBe(true);
    expect(blockedInPlanMode('design', { action: 'open' })).toBe(false);
    expect(blockedInPlanMode('design', { action: 'write' })).toBe(true);
    expect(blockedInPlanMode('design', { action: 'resolve' })).toBe(true);
    expect(blockedInPlanMode('design', {})).toBe(true);
  });

  it('allows MCP tools only when they declare readOnlyHint', () => {
    const mcp = { isReadOnly: (name: string) => name === 'mcp__fs__read' };
    expect(blockedInPlanMode('mcp__fs__read', {}, mcp)).toBe(false);
    expect(blockedInPlanMode('mcp__fs__write', {}, mcp)).toBe(true);
    expect(blockedInPlanMode('mcp__fs__read', {})).toBe(true);
  });

  it('blocks unknown tools', () => {
    expect(blockedInPlanMode('delete_everything', {})).toBe(true);
  });
});

describe('planModeNote', () => {
  it('tells the agent about the mode only when something changed', () => {
    expect(planModeNote(true, false)).toBe(PLAN_MODE_NOTE);
    expect(planModeNote(true, true)).toBe(PLAN_MODE_NOTE);
    expect(planModeNote(false, true, true)).toBe(PLAN_APPROVED_NOTE);
    expect(planModeNote(false, true)).toBe(PLAN_MODE_OFF_NOTE);
    expect(planModeNote(false, false)).toBeNull();
  });
});

describe('executeTool in Plan mode', () => {
  const settings = { cwd: 'D:\\proj', autoPilot: true, planMode: true, permissionRules: [] } as unknown as AppSettings;
  const callbacks = (approvals: string[] = []): AgentCallbacks => ({
    onTextChunk: () => {},
    onToolStart: () => {},
    onToolUpdate: () => {},
    onRequestApproval: async (t) => {
      approvals.push(t.name);
      return 'once';
    },
  });

  beforeEach(() => vi.clearAllMocks());

  it('refuses file writes without asking or touching the disk', async () => {
    const approvals: string[] = [];
    const res = await executeTool('write_file', { path: 'a.ts', content: 'x' }, settings, callbacks(approvals));
    expect(res).toEqual({ error: PLAN_MODE_BLOCKED });
    expect(approvals).toEqual([]);
    expect(bridge.snapshotFile).not.toHaveBeenCalled();
    expect(bridge.writeFile).not.toHaveBeenCalled();
  });

  it('still reads files', async () => {
    const res = await executeTool('read_file', { path: 'a.ts' }, settings, callbacks());
    expect(res).not.toEqual({ error: PLAN_MODE_BLOCKED });
    expect(bridge.readFileLines).toHaveBeenCalled();
  });

  it('runs read-only shell commands and refuses the rest, even with an allow rule', async () => {
    expect(await executeTool('run_shell_command', { command: 'git status' }, settings, callbacks())).toMatchObject({ exit_code: 0 });

    bridge.checkSecurity.mockResolvedValueOnce({ safe: true, high_risk: false, is_read_only: false, has_chaining: false });
    const allowAll = {
      ...settings,
      permissionRules: [{ id: 'r', tool: 'shell', pattern: 'npm *', action: 'allow' }],
    } as unknown as AppSettings;
    const res = await executeTool('run_shell_command', { command: 'npm install' }, allowAll, callbacks());
    expect(res).toEqual({ error: PLAN_MODE_BLOCKED });
    expect(bridge.executeCommand).toHaveBeenCalledTimes(1);
  });

  it('does not start background commands', async () => {
    const res = await executeTool('run_shell_command', { command: 'npm run dev', run_in_background: true }, settings, callbacks());
    expect(res).toEqual({ error: PLAN_MODE_BLOCKED });
    expect(bridge.startBackgroundCommand).not.toHaveBeenCalled();
    expect(bridge.checkSecurity).not.toHaveBeenCalled();
  });

  it('marks the call as rejected rather than failed', async () => {
    const updates: string[] = [];
    await executeTool('write_file', { path: 'a.ts', content: 'x' }, settings, {
      ...callbacks(),
      onToolUpdate: (t) => updates.push(t.status),
    });
    expect(updates.at(-1)).toBe('rejected');
  });

  it('works normally once Plan mode is off', async () => {
    const res = await executeTool('write_file', { path: 'a.ts', content: 'x' }, { ...settings, planMode: false }, callbacks());
    expect(res).toEqual({ message: 'saved' });
  });
});
