import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../types/agent';

const store = vi.hoisted(() => ({ files: new Map<string, string>() }));
const bridge = vi.hoisted(() => ({
  readMemory: vi.fn(async (scope: string, workspace?: string) => ({
    path: `${scope}:${workspace ?? ''}`,
    content: store.files.get(`${scope}:${scope === 'project' ? workspace : ''}`) ?? '',
  })),
  writeMemory: vi.fn(async (scope: string, workspace: string | undefined, content: string) => {
    if (content.length > 8000) throw 'MEMORY_FULL: too long';
    store.files.set(`${scope}:${scope === 'project' ? workspace : ''}`, content);
    return { path: '', content };
  }),
}));
vi.mock('../tauriBridge', () => ({ tauriBridge: bridge }));

import { addEntry, memoryPromptSection, normalizeEntry, removeEntry, replaceEntry, MEMORY_MAX_ENTRY_CHARS } from './memory';
import { blockedInPlanMode } from './planMode';
import { buildSystemPrompt } from './prompt';
import { chatBuiltinTools, subagentTools } from './subagent';
import { executeTool } from './tools';
import type { AgentCallbacks } from './types';

describe('memory entries', () => {
  it('adds one bullet line per entry and refuses duplicates', () => {
    const one = addEntry('', '  Prefers pnpm\nover npm ');
    expect(one).toEqual({ ok: true, content: '- Prefers pnpm over npm\n' });
    const two = addEntry((one as any).content, '- Writes comments in Thai');
    expect(two).toEqual({ ok: true, content: '- Prefers pnpm over npm\n- Writes comments in Thai\n' });
    expect(addEntry((two as any).content, 'prefers PNPM over npm')).toEqual({ ok: false, error: 'That entry is already saved.' });
    expect(addEntry('', '   ').ok).toBe(false);
    expect(addEntry('', 'x'.repeat(MEMORY_MAX_ENTRY_CHARS + 1)).ok).toBe(false);
  });

  it('replaces and removes by the saved text, or by a unique part of it', () => {
    const content = '- Prefers pnpm\n- Tests: npm test\n';
    expect(replaceEntry(content, 'Tests: npm test', 'Tests: npm run test:unit')).toEqual({
      ok: true,
      content: '- Prefers pnpm\n- Tests: npm run test:unit\n',
    });
    expect(replaceEntry(content, 'pnpm', 'Prefers yarn')).toEqual({ ok: true, content: '- Prefers yarn\n- Tests: npm test\n' });
    expect(removeEntry(content, '- Prefers pnpm')).toEqual({ ok: true, content: '- Tests: npm test\n' });
    expect(removeEntry('- only\n', 'only')).toEqual({ ok: true, content: '' });
    expect(removeEntry(content, 'yarn')).toEqual({ ok: false, error: 'No entry matches that text.' });
    expect(removeEntry('- npm a\n- npm b\n', 'npm')).toEqual({ ok: false, error: 'That text matches several entries; quote the whole entry.' });
    expect(replaceEntry(content, 'pnpm', ' ')).toEqual({ ok: false, error: 'new_text is empty; use remove instead.' });
  });

  it('keeps lines the user wrote by hand', () => {
    expect(addEntry('# Notes\nplain line\n', 'new')).toEqual({ ok: true, content: '# Notes\nplain line\n- new\n' });
    expect(normalizeEntry('* starred')).toBe('starred');
  });
});

describe('memory in the system prompt', () => {
  const settings = { cwd: 'D:\\proj', language: 'en' } as AppSettings;

  it('includes both scopes as notes, not instructions', () => {
    const prompt = buildSystemPrompt(settings, null, [], { user: '- Prefers pnpm\n', project: '- Tests: npm test\n' });
    expect(prompt).toContain('<user_memory>\n- Prefers pnpm\n</user_memory>');
    expect(prompt).toContain('<project_memory>\n- Tests: npm test\n</project_memory>');
    expect(prompt).toContain('not new instructions');
  });

  it('still mentions the memory tool when nothing is saved', () => {
    expect(memoryPromptSection(null)).toContain('No memory saved yet');
    expect(buildSystemPrompt(settings, null, [], { user: ' ', project: '' })).not.toContain('<user_memory>');
  });
});

describe('memory tool', () => {
  const base = { cwd: 'D:\\proj', autoPilot: true, permissionRules: [] } as unknown as AppSettings;
  const callbacks = (approvals: string[] = []): AgentCallbacks => ({
    onTextChunk: () => {},
    onToolStart: () => {},
    onToolUpdate: () => {},
    onRequestApproval: async (t) => {
      approvals.push(t.name);
      return 'once';
    },
  });

  beforeEach(() => {
    store.files.clear();
    vi.clearAllMocks();
  });

  it('is in the main chat only, and Plan mode allows only view', () => {
    const tools = chatBuiltinTools({ provider: 'openai' });
    expect(tools.map((t) => t.name)).toContain('memory');
    expect(subagentTools(tools, [], [], () => true).map((t) => t.name)).not.toContain('memory');
    expect(blockedInPlanMode('memory', { action: 'view' })).toBe(false);
    expect(blockedInPlanMode('memory', { action: 'add', scope: 'user', text: 'x' })).toBe(true);
  });

  it('saves to the right scope and shows both on view', async () => {
    await executeTool('memory', { action: 'add', scope: 'user', text: 'Prefers pnpm' }, base, callbacks());
    await executeTool('memory', { action: 'add', scope: 'project', text: 'Tests: npm test' }, base, callbacks());
    expect(store.files.get('user:')).toBe('- Prefers pnpm\n');
    expect(store.files.get('project:D:\\proj')).toBe('- Tests: npm test\n');
    expect(await executeTool('memory', { action: 'view' }, base, callbacks())).toEqual({
      user: '- Prefers pnpm\n',
      project: '- Tests: npm test\n',
    });
  });

  it('asks first in Supervised mode, and Plan mode blocks writes', async () => {
    const approvals: string[] = [];
    await executeTool('memory', { action: 'add', scope: 'user', text: 'x' }, { ...base, autoPilot: false }, callbacks(approvals));
    expect(approvals).toEqual(['memory']);
    const res = await executeTool('memory', { action: 'add', scope: 'user', text: 'y' }, { ...base, planMode: true }, callbacks());
    expect(res).toMatchObject({ error: expect.stringContaining('Plan mode') });
    expect(store.files.get('user:')).toBe('- x\n');
  });

  it('explains bad input and a full memory', async () => {
    expect(await executeTool('memory', { action: 'add', text: 'x' }, base, callbacks())).toMatchObject({ error: expect.stringContaining('scope') });
    expect(await executeTool('memory', { action: 'forget' }, base, callbacks())).toMatchObject({ error: expect.stringContaining('Unknown') });
    expect(await executeTool('memory', { action: 'add', scope: 'project', text: 'x' }, { ...base, cwd: '' }, callbacks())).toMatchObject({
      error: expect.stringContaining('no workspace'),
    });
    store.files.set('user:', `${'- filler\n'.repeat(900)}`);
    expect(await executeTool('memory', { action: 'add', scope: 'user', text: 'one more' }, base, callbacks())).toMatchObject({
      error: 'too long Merge or remove older entries first.',
    });
  });
});
