import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ApprovalDecision, PermissionRule, ToolCallRecord } from '../../types/agent';
import type { AgentCallbacks, PermissionStore } from './types';

const bridge = vi.hoisted(() => ({
  designList: vi.fn(async () => [] as unknown[]),
  designCreate: vi.fn(async (_ws: string, title: string) => ({ id: 'cafe', title, created_at: 1, updated_at: 1, version: 0 })),
  designCommit: vi.fn(async () => ({ version: 3, summary: 's', at: 1 })),
  designVersions: vi.fn(async () => [{ version: 1, summary: 'first', at: 1 }]),
  designRestore: vi.fn(async () => ({ version: 5, summary: 'Restored v2', at: 1 })),
  listDir: vi.fn(async () => [
    { name: 'index.html', path: 'x', is_dir: false, size: 1 },
    { name: 'design.json', path: 'x', is_dir: false, size: 1 },
    { name: '.versions', path: 'x', is_dir: true, size: 0 },
    { name: 'css', path: 'x', is_dir: true, size: 0 },
  ]),
  writeFile: vi.fn(async () => 'saved'),
  readFile: vi.fn(async (): Promise<string> => '[]'),
  restoreFile: vi.fn(async () => 'restored'),
  editFile: vi.fn(async () => ({ success: true, message: 'edited', occurrences: 1 })),
  snapshotFile: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock('../tauriBridge', () => ({ tauriBridge: bridge }));
const canvas = vi.hoisted(() => ({
  open: vi.fn(async (): Promise<string | null> => null),
  reloadComments: vi.fn(async () => {}),
}));
vi.mock('../design/canvas', () => ({ designCanvas: canvas }));

import { TOOL_DEFINITIONS, executeTool } from './tools';
import { deviceFrame, deviceMetrics } from '../design/canvas';

// ฟังก์ชันคำนวณจริงอยู่ในโมดูลที่ถูก mock ข้างบน จึงโหลดของจริงแยกต่างหาก
const real = await vi.importActual<{ deviceFrame: typeof deviceFrame; deviceMetrics: typeof deviceMetrics }>('../design/canvas');

const base: AppSettings = {
  provider: 'google',
  model: 'm',
  reasoningEffort: 'medium',
  language: 'en',
  autoPilot: true,
  cwd: 'D:\\proj',
  apiKeys: {} as AppSettings['apiKeys'],
  permissionRules: [],
};

function setup(decision: ApprovalDecision = 'once', rules: PermissionRule[] = []) {
  const approvals: ToolCallRecord[] = [];
  const records: ToolCallRecord[] = [];
  const checkpoints: string[] = [];
  const callbacks: AgentCallbacks = {
    onTextChunk: () => {},
    onToolStart: () => {},
    onToolUpdate: (r) => records.push(r),
    onRequestApproval: async (r) => {
      approvals.push(r);
      return decision;
    },
    onFileCheckpoint: (path) => checkpoints.push(path),
  } as AgentCallbacks;
  const permissions: PermissionStore = { rules: () => rules, addRule: () => {} };
  const run = (args: Record<string, unknown>, settings: AppSettings = base) =>
    executeTool('design', args, settings, callbacks, permissions) as Promise<Record<string, any>>;
  return { run, approvals, records, checkpoints };
}

const INDEX = 'D:\\proj/.dex/designs/cafe/index.html';

describe('design tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is offered to the model', () => {
    expect(TOOL_DEFINITIONS.some((tool) => tool.name === 'design')).toBe(true);
  });

  it('rejects an unknown action', async () => {
    const { run } = setup();
    expect((await run({ action: 'destroy' })).error).toMatch(/Unknown design action/);
  });

  it('create returns the project and its guidelines', async () => {
    const { run, records } = setup();
    const res = await run({ action: 'create', title: 'Cafe' });
    expect(bridge.designCreate).toHaveBeenCalledWith('D:\\proj', 'Cafe');
    expect(res.project).toBe('cafe');
    expect(res.guidelines).toMatch(/Design guidelines/);
    expect(records.at(-1)?.status).toBe('completed');
  });

  it('create needs a title', async () => {
    const { run } = setup();
    expect((await run({ action: 'create' })).error).toMatch(/title/);
    expect(bridge.designCreate).not.toHaveBeenCalled();
  });

  it('write saves all files as one version and shows them', async () => {
    const { run, records, checkpoints } = setup();
    const res = await run({
      action: 'write',
      project: 'cafe',
      summary: 'First draft',
      files: [
        { path: 'index.html', content: '<h1>hi</h1>' },
        { path: 'css/site.css', content: 'a{}' },
      ],
    });
    expect(bridge.writeFile).toHaveBeenCalledTimes(2);
    expect(bridge.writeFile).toHaveBeenCalledWith(INDEX, '<h1>hi</h1>', 'D:\\proj', false);
    expect(checkpoints).toEqual([INDEX, 'D:\\proj/.dex/designs/cafe/css/site.css']);
    expect(bridge.designCommit).toHaveBeenCalledTimes(1);
    expect(bridge.designCommit).toHaveBeenCalledWith('D:\\proj', 'cafe', 'First draft');
    expect(canvas.open).toHaveBeenCalledWith('cafe', { page: 'index.html' });
    expect(res.version).toBe(3);
    // หน้าจอแชทไม่ต้องเก็บ HTML ทั้งก้อน
    expect(JSON.stringify(records.at(-1)?.args)).not.toContain('<h1>');
  });

  it('write still succeeds when there is no page to show yet', async () => {
    canvas.open.mockResolvedValueOnce('no index.html');
    const { run, records } = setup();
    const res = await run({ action: 'write', project: 'cafe', files: [{ path: 'css/site.css', content: 'a{}' }] });
    expect(res.note).toMatch(/could not be shown: no index.html/);
    expect(records.at(-1)?.status).toBe('completed');
  });

  it('write shows the first page it wrote, so variants appear straight away', async () => {
    const { run } = setup();
    await run({
      action: 'write',
      project: 'cafe',
      files: [
        { path: 'css/a.css', content: 'a{}' },
        { path: 'variant-b.html', content: 'x' },
        { path: 'variant-c.html', content: 'x' },
      ],
    });
    expect(canvas.open).toHaveBeenCalledWith('cafe', { page: 'variant-b.html' });
  });

  it('write keeps the current page when it only changes other files', async () => {
    const { run } = setup();
    await run({ action: 'write', project: 'cafe', files: [{ path: 'css/a.css', content: 'a{}' }] });
    expect(canvas.open).toHaveBeenCalledWith('cafe', {});
  });

  it('delete removes files as one new version and can be undone', async () => {
    const { run, checkpoints } = setup();
    const res = await run({ action: 'delete', project: 'cafe', paths: ['variant-b.html'] });
    expect(bridge.restoreFile).toHaveBeenCalledWith('D:\\proj/.dex/designs/cafe/variant-b.html', null, 'D:\\proj');
    expect(checkpoints).toEqual(['D:\\proj/.dex/designs/cafe/variant-b.html']);
    expect(bridge.designCommit).toHaveBeenCalledTimes(1);
    expect(res.version).toBe(3);
  });

  it.each(['../x.html', 'comments.json', 'design.json', '.versions/1/index.html'])('delete refuses %s', async (path) => {
    const { run } = setup();
    expect((await run({ action: 'delete', project: 'cafe', paths: [path] })).error).toMatch(/Invalid file path/);
    expect(bridge.restoreFile).not.toHaveBeenCalled();
  });

  it('delete asks first in Supervised mode', async () => {
    const { run, approvals } = setup('reject');
    const res = await run({ action: 'delete', project: 'cafe', paths: ['a.html'] }, { ...base, autoPilot: false });
    expect(approvals).toHaveLength(1);
    expect(res.error).toMatch(/rejected/);
    expect(bridge.restoreFile).not.toHaveBeenCalled();
  });

  const COMMENT = { id: 'c1', note: 'bigger', page: 'index.html', selector: '#a', tag: 'button', text: 'Buy', html: '<button>', width: 1440, device: 'desktop', at: 1, sent: true };

  it('comments lists the open comments as data', async () => {
    bridge.readFile.mockResolvedValueOnce(JSON.stringify([COMMENT]));
    const { run } = setup();
    const res = await run({ action: 'comments', project: 'cafe' });
    expect(res.comments).toEqual([{ id: 'c1', note: 'bigger', page: 'index.html', selector: '#a', tag: 'button', text: 'Buy', screen_width: 1440 }]);
    expect(res.note).toMatch(/only if the user asked/);
  });

  it('resolve removes the comments and refreshes the pins', async () => {
    bridge.readFile.mockResolvedValueOnce(JSON.stringify([COMMENT, { ...COMMENT, id: 'c2' }]));
    const { run } = setup();
    const res = await run({ action: 'resolve', project: 'cafe', comment_ids: ['c1'] });
    expect(res).toEqual({ project: 'cafe', resolved: 1, open: 1 });
    const [path, text] = bridge.writeFile.mock.calls[0] as unknown as [string, string];
    expect(path).toBe('.dex/designs/cafe/comments.json');
    expect(JSON.parse(text).map((c: { id: string }) => c.id)).toEqual(['c2']);
    expect(canvas.reloadComments).toHaveBeenCalledWith('cafe');
  });

  it('resolve validates the project before writing', async () => {
    bridge.designVersions.mockRejectedValueOnce(new Error('bad project id'));
    const { run } = setup();
    expect((await run({ action: 'resolve', project: '../..', comment_ids: ['c1'] })).error).toBe('bad project id');
    expect(bridge.writeFile).not.toHaveBeenCalled();
  });

  it.each(['../evil.html', 'a/../../evil.html', '/abs.html', 'C:\\x.html', '.hidden.html', 'design.json', 'comments.json', 'run.exe', 'a b.html', 'หน้า.html'])(
    'write refuses the path %s',
    async (path) => {
      const { run } = setup();
      const res = await run({ action: 'write', project: 'cafe', files: [{ path, content: 'x' }] });
      expect(res.error).toMatch(/Invalid file path/);
      expect(bridge.writeFile).not.toHaveBeenCalled();
    }
  );

  it('write writes nothing if the project id is rejected', async () => {
    bridge.designVersions.mockRejectedValueOnce(new Error('bad project id'));
    const { run } = setup();
    const res = await run({ action: 'write', project: '../../src', files: [{ path: 'index.html', content: 'x' }] });
    expect(res.error).toBe('bad project id');
    expect(bridge.writeFile).not.toHaveBeenCalled();
  });

  it('write writes nothing if one file is denied by a rule', async () => {
    const rules: PermissionRule[] = [{ id: 'r', action: 'deny', tool: 'edit', pattern: '.dex/designs/cafe/secret.html' } as PermissionRule];
    const { run } = setup('once', rules);
    const res = await run({
      action: 'write',
      project: 'cafe',
      files: [
        { path: 'index.html', content: 'x' },
        { path: 'secret.html', content: 'x' },
      ],
    });
    expect(res.error).toMatch(/permission rule/);
    expect(bridge.writeFile).not.toHaveBeenCalled();
  });

  it('asks before writing in Supervised mode and stops when rejected', async () => {
    const { run, approvals } = setup('reject');
    const res = await run({ action: 'write', project: 'cafe', files: [{ path: 'index.html', content: 'x' }] }, { ...base, autoPilot: false });
    expect(approvals).toHaveLength(1);
    expect(res.error).toMatch(/rejected/);
    expect(bridge.writeFile).not.toHaveBeenCalled();
    expect(bridge.designCommit).not.toHaveBeenCalled();
  });

  it('edit changes the file and saves a version', async () => {
    const { run } = setup();
    const res = await run({
      action: 'edit',
      project: 'cafe',
      path: 'index.html',
      summary: 'New title',
      edits: [{ target_content: 'a', replacement_content: 'b' }],
    });
    expect(bridge.editFile).toHaveBeenCalledWith(INDEX, [{ target_content: 'a', replacement_content: 'b', replace_all: false }], 'D:\\proj', false);
    expect(bridge.designCommit).toHaveBeenCalledWith('D:\\proj', 'cafe', 'New title');
    expect(res.version).toBe(3);
  });

  it('a failed edit saves no version', async () => {
    bridge.editFile.mockResolvedValueOnce({ success: false, message: 'not found', occurrences: 0 });
    const { run } = setup();
    await run({ action: 'edit', project: 'cafe', path: 'index.html', edits: [{ target_content: 'a', replacement_content: 'b' }] });
    expect(bridge.designCommit).not.toHaveBeenCalled();
    expect(canvas.open).not.toHaveBeenCalled();
  });

  it('open shows the page and lists only design files', async () => {
    const { run } = setup();
    const res = await run({ action: 'open', project: 'cafe', version: 1 });
    expect(canvas.open).toHaveBeenCalledWith('cafe', { version: 1, page: undefined });
    expect(res.files).toEqual(['index.html', 'css/']);
    expect(res.guidelines).toBeTruthy();
  });

  it('restore brings back a version as a new one', async () => {
    const { run, records } = setup();
    const res = await run({ action: 'restore', project: 'cafe', version: 2 });
    expect(bridge.designRestore).toHaveBeenCalledWith('D:\\proj', 'cafe', 2);
    expect(canvas.open).toHaveBeenCalledWith('cafe');
    expect(res.version).toBe(5);
    expect(records.at(-1)?.output).toBe('v2 → v5');
  });
});

describe('device emulation', () => {
  it('shrinks a wide page to fit the frame and keeps the frame full height', () => {
    const metrics = real.deviceMetrics('desktop', { width: 720, height: 600 });
    expect(metrics).toEqual({ width: 1440, height: 1200, deviceScaleFactor: 0, mobile: false, scale: 0.5 });
  });

  it('does not enlarge a phone in a big frame', () => {
    const frame = real.deviceFrame('mobile', { width: 720, height: 600 });
    expect(frame).toEqual({ width: 390, height: 600 });
    expect(real.deviceMetrics('mobile', frame)).toEqual({ width: 390, height: 600, deviceScaleFactor: 0, mobile: true, scale: 1 });
  });
});
