import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../types/agent';
import type { AgentCallbacks } from './types';

const bridge = vi.hoisted(() => ({
  readSkillFile: vi.fn(async () => '---\nname: release\ndescription: Cut a release\n---\n\n1. Bump the version\n'),
}));
vi.mock('../tauriBridge', () => ({ tauriBridge: bridge }));

import { matchSkillCommand, skillInvocationBlock, skillsPromptSection, stripFrontmatter } from './skills';
import { executeTool } from './tools';
import { buildSystemPrompt } from './prompt';

const release = { name: 'release', description: 'Cut a release', dir: 'D:\\proj\\.dex\\skills\\release', source: 'workspace' as const };

describe('skill helpers', () => {
  it('strips frontmatter and keeps the body', () => {
    expect(stripFrontmatter('---\nname: a\n---\nBody\n')).toBe('Body');
    expect(stripFrontmatter('\uFEFF---\r\nname: a\r\n---\r\n\r\nBody')).toBe('Body');
    expect(stripFrontmatter('No frontmatter')).toBe('No frontmatter');
  });

  it('matches /skill commands case-insensitively and keeps the rest of the prompt', () => {
    expect(matchSkillCommand('/Release v2.0 please', [release])).toEqual({ skill: release, rest: 'v2.0 please' });
    expect(matchSkillCommand('/release', [release])?.rest).toBe('');
    expect(matchSkillCommand('/unknown', [release])).toBeNull();
    expect(matchSkillCommand('release', [release])).toBeNull();
  });

  it('lists skills in the system prompt only when there are some', () => {
    expect(skillsPromptSection([])).toBe('');
    const prompt = buildSystemPrompt({ cwd: 'D:\\proj', language: 'en' } as AppSettings, null, [release]);
    expect(prompt).toContain('- release: Cut a release');
    expect(prompt).toContain('use_skill');
    expect(skillInvocationBlock(release, 'Do it')).toContain('<skill name="release">\nDo it\n</skill>');
  });
});

describe('use_skill tool', () => {
  const settings = { cwd: 'D:\\proj', autoPilot: true, permissionRules: [] } as unknown as AppSettings;
  const callbacks: AgentCallbacks = {
    onTextChunk: () => {},
    onToolStart: () => {},
    onToolUpdate: () => {},
    onRequestApproval: async () => 'once',
  };
  const run = (args: Record<string, unknown>) => executeTool('use_skill', args, settings, callbacks, undefined, { skills: [release] });

  beforeEach(() => vi.clearAllMocks());

  it('returns the instructions without frontmatter', async () => {
    expect(await run({ name: 'Release' })).toEqual({ skill: 'release', folder: release.dir, content: '1. Bump the version' });
    expect(bridge.readSkillFile).toHaveBeenCalledWith(release.dir, undefined, 'D:\\proj');
  });

  it('reads other files from the skill folder as-is', async () => {
    bridge.readSkillFile.mockResolvedValueOnce('---\nraw\n---');
    expect(await run({ name: 'release', file: 'notes.md' })).toMatchObject({ content: '---\nraw\n---' });
    expect(bridge.readSkillFile).toHaveBeenCalledWith(release.dir, 'notes.md', 'D:\\proj');
  });

  it('names the available skills when the name is wrong', async () => {
    const res = (await run({ name: 'deploy' })) as { error: string };
    expect(res.error).toContain('Available: release');
    expect(bridge.readSkillFile).not.toHaveBeenCalled();
  });
});
