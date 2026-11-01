import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ApprovalDecision, PermissionRule, ToolCallRecord } from '../../types/agent';
import type { BrowserDriver } from '../browser/actions';
import type { AgentCallbacks, PermissionStore } from './types';

const EDITOR_URL = 'http://127.0.0.1:17420/index.html?embedded';
const bridge = vi.hoisted(() => ({
  gdocxUrl: vi.fn(async () => 'http://127.0.0.1:17420/index.html?embedded'),
  readBinaryFile: vi.fn(async () => 'UEsDBA=='),
  writeBinaryFile: vi.fn(async () => ({ message: 'saved', backup: null as string | null })),
  snapshotFile: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock('../tauriBridge', () => ({ tauriBridge: bridge }));

import { executeTool } from './tools';

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

const INFO = { path: 'D:\\proj/a.docx', name: 'a.docx', modified: false, pages: 2, blocks: 5, styles: ['Normal'], backups: [] as string[] };

/** หน้า G-docx ปลอม: ตอบสคริปต์ที่ tool เรียกผ่าน Runtime.evaluate และจดไว้ให้เทสต์ตรวจ */
function fakeEditor(opts: { url?: string | null; info?: Partial<typeof INFO>; ready?: boolean; fail?: string } = {}) {
  const scripts: string[] = [];
  let url = opts.url === undefined ? EDITOR_URL : opts.url;
  const info = { ...INFO, ...opts.info };
  const driver: BrowserDriver = {
    navigate: vi.fn(async (target: string) => {
      url = target;
      return null;
    }),
    currentUrl: async () => url,
    sleep: async () => {},
    show: vi.fn(async () => {}),
    cdp: async (_method, params = {}) => {
      const expr = String(params.expression);
      scripts.push(expr);
      if (opts.fail && expr.startsWith('GDocxApi.edit')) {
        return { exceptionDetails: { exception: { description: `Error: ${opts.fail}\n    at edit (api.js:1:1)` } } };
      }
      const value = expr.includes('ready()')
        ? opts.ready !== false
        : expr.startsWith('GDocxApi.read')
          ? { ...info, content: '[0] Hello', next_offset: null }
          : expr.startsWith('GDocxApi.exportDocx')
            ? 'RE9DWA=='
            : expr.startsWith('GDocxApi.edit')
              ? { ...info, modified: true, results: [{}] }
              : info;
      return { result: { value } };
    },
  };
  return { driver, scripts };
}

function setup(driver: BrowserDriver, decision: ApprovalDecision = 'once', rules: PermissionRule[] = []) {
  const approvals: ToolCallRecord[] = [];
  const records: ToolCallRecord[] = [];
  const callbacks: AgentCallbacks = {
    onTextChunk: () => {},
    onToolStart: () => {},
    onToolUpdate: (r) => records.push(r),
    onRequestApproval: async (tool) => {
      approvals.push(tool);
      return decision;
    },
  };
  const store: PermissionStore = { rules: () => rules, addRule: () => {} };
  const run = (args: Record<string, any>, settings = base) =>
    executeTool('docx', args, settings, callbacks, store, { browser: driver }) as Promise<any>;
  return { approvals, records, run };
}

describe('docx tool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads the editor, then sends the file into it', async () => {
    const { driver, scripts } = fakeEditor({ url: null });
    const { approvals, run } = setup(driver);
    const res = await run({ action: 'open', path: 'a.docx' });
    expect(driver.navigate).toHaveBeenCalledWith(EDITOR_URL);
    expect(driver.show).toHaveBeenCalled();
    expect(bridge.readBinaryFile).toHaveBeenCalledWith('D:\\proj/a.docx', 'D:\\proj', false);
    expect(scripts.at(-1)).toBe('GDocxApi.open("UEsDBA==","a.docx","D:\\\\proj/a.docx")');
    expect(res).toMatchObject({ pages: 2, blocks: 5 });
    expect(approvals).toEqual([]);
  });

  it('never sends a file to a page from another origin, even one that defines GDocxApi', async () => {
    const { driver, scripts } = fakeEditor({ url: 'https://evil.example/' });
    const { run } = setup(driver);
    await run({ action: 'open', path: 'a.docx' });
    expect(driver.navigate).toHaveBeenCalledWith(EDITOR_URL);
    expect(scripts.filter((s) => s.startsWith('GDocxApi.open'))).toHaveLength(1);
    const reader = fakeEditor({ url: 'https://evil.example/' });
    const res = await setup(reader.driver).run({ action: 'read' });
    expect(res.error).toMatch(/No document is open/);
    expect(reader.scripts).toEqual([]);
  });

  it('only opens .docx files', async () => {
    const { driver } = fakeEditor();
    const res = await setup(driver).run({ action: 'open', path: 'old.doc' });
    expect(res.error).toMatch(/\.docx/);
    expect(bridge.readBinaryFile).not.toHaveBeenCalled();
  });

  it('refuses to replace a document with unsaved changes unless told to discard them', async () => {
    const { driver, scripts } = fakeEditor({ info: { modified: true } });
    const { run } = setup(driver);
    expect((await run({ action: 'open', path: 'b.docx' })).error).toMatch(/unsaved changes/);
    expect(scripts.some((s) => s.startsWith('GDocxApi.open'))).toBe(false);
    await run({ action: 'open', path: 'b.docx', discard: true });
    expect(scripts.some((s) => s.startsWith('GDocxApi.open'))).toBe(true);
  });

  it('honours deny rules on open and save', async () => {
    const { driver } = fakeEditor();
    const deny = (tool: 'read' | 'edit'): PermissionRule => ({ id: 'r', action: 'deny', tool, pattern: 'a.docx' });
    expect((await setup(driver, 'once', [deny('read')]).run({ action: 'open', path: 'a.docx' })).error).toMatch(/Blocked/);
    expect((await setup(driver, 'once', [deny('edit')]).run({ action: 'save' })).error).toMatch(/Blocked/);
    expect(bridge.readBinaryFile).not.toHaveBeenCalled();
    expect(bridge.writeBinaryFile).not.toHaveBeenCalled();
  });

  it('marks read results as untrusted and points at the next page', async () => {
    const { driver } = fakeEditor();
    const res = await setup(driver).run({ action: 'read', offset: 2 });
    expect(res.content).toBe('[0] Hello');
    expect(res.note).toMatch(/untrusted/);
  });

  it('applies edits without asking, and reports the failure of a batch cleanly', async () => {
    const ok = fakeEditor({ info: {} });
    const { approvals, run } = setup(ok.driver);
    const res = await run({ action: 'edit', ops: JSON.stringify([{ op: 'replace_text', find: 'a', replace: 'b' }]) });
    expect(res.note).toMatch(/Call save/);
    expect(approvals).toEqual([]);
    expect(ok.scripts.at(-1)).toBe('GDocxApi.edit([{"op":"replace_text","find":"a","replace":"b"}])');

    const bad = fakeEditor({ fail: 'Operation 0 (set_text): No block 9' });
    expect((await setup(bad.driver).run({ action: 'edit', ops: [{ op: 'set_text', block: 9 }] })).error).toBe('Operation 0 (set_text): No block 9');
    expect((await setup(bad.driver).run({ action: 'edit', ops: [] })).error).toMatch(/non-empty/);
  });

  it('saves over the opened file and backs up the original once', async () => {
    const first = fakeEditor();
    const res = await setup(first.driver).run({ action: 'save' });
    expect(bridge.writeBinaryFile).toHaveBeenLastCalledWith('D:\\proj/a.docx', 'RE9DWA==', 'D:\\proj', false, true);
    expect(first.scripts.at(-1)).toBe('GDocxApi.markSaved("D:\\\\proj/a.docx","a.docx",true)');
    expect(res.message).toBe('saved');

    const again = fakeEditor({ info: { backups: ['D:\\proj/a.docx'] } });
    await setup(again.driver).run({ action: 'save' });
    expect(bridge.writeBinaryFile).toHaveBeenLastCalledWith('D:\\proj/a.docx', 'RE9DWA==', 'D:\\proj', false, false);
  });

  it('asks before saving in supervised mode, and writes nothing when rejected', async () => {
    const supervised = { ...base, autoPilot: false };
    const { driver } = fakeEditor();
    const { approvals, run } = setup(driver, 'reject');
    const res = await run({ action: 'save' }, supervised);
    expect(approvals).toHaveLength(1);
    expect(res.error).toMatch(/rejected/);
    expect(bridge.writeBinaryFile).not.toHaveBeenCalled();
  });

  it('needs a path to save a document that has no file', async () => {
    const { driver } = fakeEditor({ info: { path: null as unknown as string } });
    expect((await setup(driver).run({ action: 'save' })).error).toMatch(/pass path/);
    await setup(driver).run({ action: 'save', path: 'new.docx' });
    expect(bridge.writeBinaryFile).toHaveBeenCalledWith('D:\\proj/new.docx', 'RE9DWA==', 'D:\\proj', false, true);
    expect((await setup(driver).run({ action: 'save', path: 'new.txt' })).error).toMatch(/\.docx/);
  });

  it('rejects unknown actions', async () => {
    const { driver } = fakeEditor();
    expect((await setup(driver).run({ action: 'print' })).error).toMatch(/Unknown docx action/);
  });
});
