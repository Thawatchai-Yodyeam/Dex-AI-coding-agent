import { describe, expect, it, vi } from 'vitest';
import type { AppSettings, ToolCallRecord } from '../../types/agent';
import {
  SUBAGENT_MAX_REPORT_CHARS,
  SUBAGENT_MAX_STEPS,
  SUBAGENT_TOOL,
  runSubagent,
  subagentMayCall,
  subagentSystemPrompt,
  subagentTools,
  type SubagentDeps,
} from './subagent';
import { stepLimitNote, type AgentCallbacks, type ToolDefinition, type TurnContext, type TurnResult } from './types';

vi.mock('../tauriBridge', () => ({ tauriBridge: {} }));

const def = (name: string): ToolDefinition => ({ name, description: name, parameters: { type: 'object', properties: {} } });
const BUILTINS = [
  'run_shell_command',
  'read_background_output',
  'stop_background_command',
  'read_file',
  'write_file',
  'list_directory',
  'replace_file_content',
  'multi_edit_file',
  'grep_search',
  'update_todos',
  'web_fetch',
  'browser',
  'docx',
  'design',
  'find_files',
].map(def);

const settings = { cwd: 'D:\\proj', language: 'en', autoPilot: true, permissionRules: [] } as unknown as AppSettings;
const usage = (n: number) => ({ promptTokens: n, completionTokens: 0, totalTokens: n });

describe('subagentTools', () => {
  it('keeps only read-only tools that do not share app state', () => {
    const names = subagentTools(BUILTINS, [], [], () => false).map((t) => t.name);
    expect(names.sort()).toEqual(['find_files', 'grep_search', 'list_directory', 'read_file', 'run_shell_command', 'web_fetch']);
  });

  it('adds use_skill when there are skills and only read-only MCP tools', () => {
    const skills = [{ name: 's', description: 'd', path: 'p', dir: 'd' }] as any;
    const names = subagentTools(BUILTINS, [def('mcp__a__read'), def('mcp__a__write')], skills, (n) => n === 'mcp__a__read').map((t) => t.name);
    expect(names).toContain('use_skill');
    expect(names).toContain('mcp__a__read');
    expect(names).not.toContain('mcp__a__write');
  });

  it('never offers the subagent tool itself', () => {
    const tools = subagentTools([...BUILTINS, SUBAGENT_TOOL], [], [], () => true);
    expect(tools.some((t) => t.name === 'subagent')).toBe(false);
    expect(subagentMayCall('subagent', [...tools, SUBAGENT_TOOL])).toBe(false);
  });
});

describe('subagentSystemPrompt', () => {
  it('names the workspace and the report language', () => {
    expect(subagentSystemPrompt(settings, '')).toContain('D:\\proj');
    expect(subagentSystemPrompt(settings, '')).toContain('in English');
    expect(subagentSystemPrompt({ ...settings, language: 'th' } as AppSettings, '')).toContain('Thai');
  });
});

describe('runSubagent', () => {
  const parent: ToolCallRecord = { id: 'tool-parent', name: 'subagent', args: {}, status: 'running' };

  function setup(driver: (ctx: TurnContext) => Promise<TurnResult>) {
    const started: ToolCallRecord[] = [];
    const approvals: ToolCallRecord[] = [];
    const ran: string[] = [];
    const parentCallbacks: AgentCallbacks = {
      onTextChunk: vi.fn(),
      onToolStart: (t) => started.push(t),
      onToolUpdate: () => {},
      onRequestApproval: async (t) => {
        approvals.push(t);
        return 'once';
      },
    };
    const tools = subagentTools(BUILTINS, [def('mcp__a__read')], [], (n) => n === 'mcp__a__read');
    const deps: SubagentDeps = {
      settings,
      apiKey: 'k',
      systemPrompt: 'sys',
      tools,
      driver: (ctx) => driver(ctx),
      runTool: async (name, args, callbacks) => {
        ran.push(name);
        const record: ToolCallRecord = { id: `tool-${name}`, name, args, status: 'running' };
        callbacks.onToolStart(record);
        if (name === 'run_shell_command') await callbacks.onRequestApproval({ ...record, status: 'pending_approval' });
        return { content: 'ok' };
      },
      mcp: { isReadOnly: (n) => n === 'mcp__a__read' },
    };
    return { deps, parentCallbacks, started, approvals, ran };
  }

  it('starts from an empty history with its own prompt and tools, and returns only the report', async () => {
    let seen: TurnContext | null = null;
    const { deps, parentCallbacks } = setup(async (ctx) => {
      seen = ctx;
      return { text: '  The answer.  ', usage: usage(10) };
    });
    const res = await runSubagent(deps, 'find things', parent, parentCallbacks);
    expect(res).toEqual({ report: 'The answer.', usage: usage(10), toolCalls: 0 });
    expect(seen!.history).toEqual([]);
    expect(seen!.systemPrompt).toBe('sys');
    expect(seen!.tools.map((t) => t.name)).not.toContain('write_file');
    expect(parentCallbacks.onTextChunk).not.toHaveBeenCalled();
  });

  it('shows its tool calls under the parent card and forwards approvals', async () => {
    const { deps, parentCallbacks, started, approvals, ran } = setup(async (ctx) => {
      await ctx.runTool('read_file', { path: 'a.ts' });
      await ctx.runTool('run_shell_command', { command: 'git log' });
      return { text: 'done', usage: usage(1) };
    });
    const res = await runSubagent(deps, 'x', parent, parentCallbacks);
    expect(ran).toEqual(['read_file', 'run_shell_command']);
    expect(started.map((t) => [t.name, t.parentId])).toEqual([
      ['read_file', 'tool-parent'],
      ['run_shell_command', 'tool-parent'],
    ]);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].parentId).toBe('tool-parent');
    expect(res.toolCalls).toBe(2);
  });

  it('refuses tools outside its list without running them', async () => {
    const results: unknown[] = [];
    const { deps, parentCallbacks, ran, started } = setup(async (ctx) => {
      results.push(await ctx.runTool('write_file', { path: 'a.ts', content: 'x' }));
      results.push(await ctx.runTool('subagent', { prompt: 'again' }));
      results.push(await ctx.runTool('browser', { action: 'snapshot' }));
      results.push(await ctx.runTool('run_shell_command', { command: 'npm run dev', run_in_background: true }));
      results.push(await ctx.runTool('mcp__a__read', {}));
      return { text: 'done', usage: usage(1) };
    });
    await runSubagent(deps, 'x', parent, parentCallbacks);
    expect(results.slice(0, 4)).toEqual([
      { error: 'write_file is not available to a read-only subagent.' },
      { error: 'subagent is not available to a read-only subagent.' },
      { error: 'browser is not available to a read-only subagent.' },
      { error: 'run_shell_command is not available to a read-only subagent.' },
    ]);
    expect(ran).toEqual(['mcp__a__read']);
    expect(started).toHaveLength(1);
  });

  it('stops at its step limit without asking the user', async () => {
    const { deps, parentCallbacks, approvals } = setup(async (ctx) => {
      expect(await ctx.shouldContinue!(0)).toBe(true);
      expect(await ctx.shouldContinue!(SUBAGENT_MAX_STEPS - 1)).toBe(true);
      expect(await ctx.shouldContinue!(SUBAGENT_MAX_STEPS)).toBe(false);
      return { text: `partial\n\n${stepLimitNote('en', SUBAGENT_MAX_STEPS)}`, usage: usage(1) };
    });
    const res = await runSubagent(deps, 'x', parent, parentCallbacks);
    expect(res.report).toContain('may be incomplete');
    expect(approvals).toEqual([]);
  });

  it('caps a very long report and fills in an empty one', async () => {
    const long = setup(async () => ({ text: 'x'.repeat(SUBAGENT_MAX_REPORT_CHARS + 500), usage: usage(1) }));
    const res = await runSubagent(long.deps, 'x', parent, long.parentCallbacks);
    expect(res.report.length).toBeLessThan(SUBAGENT_MAX_REPORT_CHARS + 100);
    expect(res.report).toContain('truncated');

    const empty = setup(async () => ({ text: '   ', usage: usage(1) }));
    expect((await runSubagent(empty.deps, 'x', parent, empty.parentCallbacks)).report).toContain('without writing a report');
  });

  it('lets driver errors through so the tool call fails', async () => {
    const { deps, parentCallbacks } = setup(async () => {
      throw new Error('API down');
    });
    await expect(runSubagent(deps, 'x', parent, parentCallbacks)).rejects.toThrow('API down');
  });
});
