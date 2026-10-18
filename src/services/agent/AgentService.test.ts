import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../types/agent';

const bridge = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('../tauriBridge', () => ({ tauriBridge: bridge }));

import { MultiProviderAgentService } from './AgentService';

const settings = (patch: Partial<AppSettings> = {}) =>
  ({ cwd: 'D:\proj', provider: 'deepseek', model: 'deepseek-flash', language: 'en', apiKeys: { deepseek: 'k' }, ...patch }) as AppSettings;

describe('loadProjectInstructions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the first instruction file that exists and is not blank', async () => {
    bridge.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('DEX.md')) throw new Error('not found');
      if (path.endsWith('AGENTS.md')) return 'Run npm test.';
      return 'claude';
    });
    const agent = new MultiProviderAgentService(settings());
    expect(await agent.loadProjectInstructions()).toEqual({ file: 'AGENTS.md', content: 'Run npm test.' });
    expect(bridge.readFile).toHaveBeenCalledWith('D:\proj/DEX.md', 'D:\proj');
  });

  it('returns null without a workspace or any file', async () => {
    bridge.readFile.mockRejectedValue(new Error('not found'));
    expect(await new MultiProviderAgentService(settings({ cwd: '' })).loadProjectInstructions()).toBeNull();
    expect(await new MultiProviderAgentService(settings()).loadProjectInstructions()).toBeNull();
  });

  it('truncates very long files', async () => {
    bridge.readFile.mockResolvedValue('x'.repeat(30_000));
    const res = await new MultiProviderAgentService(settings()).loadProjectInstructions();
    expect(res!.content.length).toBeLessThan(21_000);
    expect(res!.content).toContain('[... truncated ...]');
  });
});

describe('sendMessage with images', () => {
  it('rejects images for providers without vision before calling the API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const agent = new MultiProviderAgentService(settings());
    await expect(
      agent.sendMessage(
        { text: 'see', images: [{ id: 'i', name: 'a.png', mediaType: 'image/png', data: 'QQ==' }] },
        { onTextChunk: () => {}, onToolStart: () => {}, onToolUpdate: () => {}, onRequestApproval: async () => 'once' }
      )
    ).rejects.toThrow(/does not accept images/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
