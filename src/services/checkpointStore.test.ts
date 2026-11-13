import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ tauri: true }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => env.tauri, invoke: vi.fn() }));
const bridge = vi.hoisted(() => ({
  saveCheckpoint: vi.fn(async (_s: string, _m: string, _data: string) => {}),
  loadCheckpoints: vi.fn(async (_s: string): Promise<string[]> => []),
  deleteCheckpoint: vi.fn(async (_s: string, _m: string) => {}),
  deleteCheckpoints: vi.fn(async (_s: string) => {}),
}));
vi.mock('./tauriBridge', () => ({ tauriBridge: bridge }));

import {
  CHECKPOINT_MAX_AGE_MS,
  deleteCheckpoint,
  deleteSessionCheckpoints,
  loadCheckpoints,
  newCheckpoint,
  parseCheckpoint,
  saveCheckpoint,
  serializeCheckpoint,
} from './checkpointStore';

const NOW = 1_800_000_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  bridge.saveCheckpoint.mockReset().mockResolvedValue(undefined);
  bridge.loadCheckpoints.mockReset().mockResolvedValue([]);
  bridge.deleteCheckpoint.mockReset().mockResolvedValue(undefined);
  bridge.deleteCheckpoints.mockReset().mockResolvedValue(undefined);
  env.tauri = true;
});

function sample() {
  const ckpt = newCheckpoint('session-1', 'asst-1', 'D:\\proj', NOW);
  ckpt.originals.set('D:\\proj/a.ts', 'before');
  ckpt.originals.set('D:\\proj/new.ts', null);
  return ckpt;
}

describe('serializeCheckpoint / parseCheckpoint', () => {
  it('round-trips originals, new files and the git snapshot', () => {
    const ckpt = sample();
    ckpt.git = { tree: 'a'.repeat(40), pathsBefore: new Set(['D:\\proj/a.ts']) };
    const back = parseCheckpoint(serializeCheckpoint(ckpt))!;
    expect(back.sessionId).toBe('session-1');
    expect(back.messageId).toBe('asst-1');
    expect(back.cwd).toBe('D:\\proj');
    expect(back.createdAt).toBe(NOW);
    expect([...back.originals]).toEqual([
      ['D:\\proj/a.ts', 'before'],
      ['D:\\proj/new.ts', null],
    ]);
    expect(back.git).toEqual({ tree: 'a'.repeat(40), pathsBefore: new Set(['D:\\proj/a.ts']) });
    expect(back.lost).toEqual([]);
  });

  it('never writes the content of a secret file, and reports it as lost after a reload', () => {
    const ckpt = sample();
    ckpt.originals.set('D:\\proj/.env', 'API_KEY=s3cret');
    ckpt.memoryOnly.add('D:\\proj/.env');
    const json = serializeCheckpoint(ckpt);
    expect(json).not.toContain('s3cret');
    const back = parseCheckpoint(json)!;
    expect(back.originals.has('D:\\proj/.env')).toBe(false);
    expect(back.lost).toEqual(['D:\\proj/.env']);
    // บันทึกซ้ำหลังโหลดกลับมาต้องไม่ลืมว่าไฟล์นี้ย้อนไม่ได้
    expect(parseCheckpoint(serializeCheckpoint(back))!.lost).toEqual(['D:\\proj/.env']);
  });

  it('rejects broken or unknown data', () => {
    expect(parseCheckpoint('not json')).toBeNull();
    expect(parseCheckpoint('null')).toBeNull();
    expect(parseCheckpoint(JSON.stringify({ v: 2 }))).toBeNull();
    const valid = JSON.parse(serializeCheckpoint(sample()));
    expect(parseCheckpoint(JSON.stringify({ ...valid, originals: [['a.ts', 5]] }))).toBeNull();
    expect(parseCheckpoint(JSON.stringify({ ...valid, cwd: 1 }))).toBeNull();
  });
});

describe('saveCheckpoint', () => {
  it('writes the state at the time of the write, merging calls made while one is in flight', async () => {
    let release!: () => void;
    bridge.saveCheckpoint.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    const ckpt = sample();
    const first = saveCheckpoint(ckpt);
    await Promise.resolve();
    ckpt.originals.set('D:\\proj/b.ts', 'b');
    const second = saveCheckpoint(ckpt);
    ckpt.originals.set('D:\\proj/c.ts', 'c');
    const third = saveCheckpoint(ckpt);
    release();
    await Promise.all([first, second, third]);

    expect(bridge.saveCheckpoint).toHaveBeenCalledTimes(2);
    const last = parseCheckpoint(bridge.saveCheckpoint.mock.calls[1][2])!;
    expect([...last.originals.keys()]).toEqual(['D:\\proj/a.ts', 'D:\\proj/new.ts', 'D:\\proj/b.ts', 'D:\\proj/c.ts']);
  });

  it('does not bring a checkpoint back after it was deleted', async () => {
    let release!: () => void;
    bridge.saveCheckpoint.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    const ckpt = sample();
    const first = saveCheckpoint(ckpt);
    await Promise.resolve();
    const queued = saveCheckpoint(ckpt);
    const removed = deleteCheckpoint(ckpt);
    release();
    await Promise.all([first, queued, removed]);

    expect(bridge.saveCheckpoint).toHaveBeenCalledTimes(1);
    expect(bridge.deleteCheckpoint).toHaveBeenCalledWith('session-1', 'asst-1');
    expect(bridge.deleteCheckpoint.mock.invocationCallOrder[0]).toBeGreaterThan(bridge.saveCheckpoint.mock.invocationCallOrder[0]);
  });

  it('keeps working after a failed write', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.saveCheckpoint.mockRejectedValueOnce(new Error('disk full'));
    const ckpt = sample();
    await saveCheckpoint(ckpt);
    await saveCheckpoint(ckpt);
    expect(bridge.saveCheckpoint).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('does nothing outside the desktop app', async () => {
    env.tauri = false;
    await saveCheckpoint(sample());
    await deleteSessionCheckpoints('session-1');
    expect(await loadCheckpoints('session-1')).toEqual([]);
    expect(bridge.saveCheckpoint).not.toHaveBeenCalled();
    expect(bridge.deleteCheckpoints).not.toHaveBeenCalled();
    expect(bridge.loadCheckpoints).not.toHaveBeenCalled();
  });
});

describe('loadCheckpoints', () => {
  it('skips broken files and checkpoints of another chat', async () => {
    const other = newCheckpoint('session-2', 'asst-7', 'D:\\proj', NOW);
    bridge.loadCheckpoints.mockResolvedValue(['{broken', serializeCheckpoint(sample()), serializeCheckpoint(other)]);
    const loaded = await loadCheckpoints('session-1', NOW + 1000);
    expect(loaded.map((c) => c.messageId)).toEqual(['asst-1']);
    expect(bridge.deleteCheckpoint).not.toHaveBeenCalled();
  });

  it('drops and deletes checkpoints older than the limit', async () => {
    const old = newCheckpoint('session-1', 'asst-old', 'D:\\proj', NOW - CHECKPOINT_MAX_AGE_MS - 1);
    bridge.loadCheckpoints.mockResolvedValue([serializeCheckpoint(old), serializeCheckpoint(sample())]);
    const loaded = await loadCheckpoints('session-1', NOW);
    expect(loaded.map((c) => c.messageId)).toEqual(['asst-1']);
    await deleteSessionCheckpoints('session-1');
    expect(bridge.deleteCheckpoint).toHaveBeenCalledWith('session-1', 'asst-old');
  });

  it('waits for a pending delete of the chat before reading', async () => {
    const order: string[] = [];
    bridge.deleteCheckpoints.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('delete');
    });
    bridge.loadCheckpoints.mockImplementationOnce(async () => {
      order.push('load');
      return [];
    });
    void deleteSessionCheckpoints('session-1');
    await loadCheckpoints('session-1', NOW);
    expect(order).toEqual(['delete', 'load']);
  });
});
