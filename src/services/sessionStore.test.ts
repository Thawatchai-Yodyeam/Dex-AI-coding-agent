import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession } from '../types/agent';

const env = vi.hoisted(() => ({ tauri: true }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => env.tauri, invoke: vi.fn() }));
const bridge = vi.hoisted(() => ({
  loadChatSessions: vi.fn(async (): Promise<string[]> => []),
  saveChatSession: vi.fn(async (_id: string, _data: string) => {}),
  deleteChatSession: vi.fn(async (_id: string) => {}),
}));
vi.mock('./tauriBridge', () => ({ tauriBridge: bridge }));

import {
  ACTIVE_SESSION_STORAGE_KEY,
  SESSIONS_STORAGE_KEY,
  loadStoredSessions,
  resetSessionLoader,
  sessionStore,
} from './sessionStore';

const session = (id: string, createdAt: number, content = 'hi'): ChatSession => ({
  id,
  title: id,
  createdAt,
  updatedAt: createdAt,
  messages: [{ id: `${id}-m`, role: 'user', content, timestamp: createdAt }],
});

function fakeStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

let storage: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  vi.clearAllMocks();
  bridge.loadChatSessions.mockReset().mockResolvedValue([]);
  bridge.saveChatSession.mockReset().mockResolvedValue(undefined);
  env.tauri = true;
  storage = fakeStorage();
  vi.stubGlobal('localStorage', storage);
  resetSessionLoader();
});

describe('loadStoredSessions', () => {
  it('reads chat files newest first and remembers the active chat', async () => {
    bridge.loadChatSessions.mockResolvedValue([
      JSON.stringify(session('old', 1)),
      'not json',
      JSON.stringify({ id: 'broken' }),
      JSON.stringify(session('new', 2)),
    ]);
    storage.setItem(ACTIVE_SESSION_STORAGE_KEY, 'old');
    const res = await loadStoredSessions();
    expect(res.sessions.map((s) => s.id)).toEqual(['new', 'old']);
    expect(res.activeId).toBe('old');
  });

  it('moves chats from localStorage to files, then drops the old key', async () => {
    bridge.loadChatSessions.mockResolvedValue([JSON.stringify(session('a', 1, 'from file'))]);
    storage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify([session('a', 1, 'stale copy'), session('b', 2)]));
    const res = await loadStoredSessions();
    // ไฟล์ชนะเมื่อ id ซ้ำ ย้ายเฉพาะแชทที่ยังไม่มีไฟล์
    expect(bridge.saveChatSession).toHaveBeenCalledTimes(1);
    expect(bridge.saveChatSession.mock.calls[0][0]).toBe('b');
    expect(res.sessions.find((s) => s.id === 'a')?.messages[0].content).toBe('from file');
    expect(storage.getItem(SESSIONS_STORAGE_KEY)).toBeNull();
  });

  it('keeps localStorage when a chat could not be moved', async () => {
    storage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify([session('a', 1)]));
    bridge.saveChatSession.mockRejectedValueOnce(new Error('disk full'));
    const res = await loadStoredSessions();
    expect(res.sessions.map((s) => s.id)).toEqual(['a']);
    expect(storage.getItem(SESSIONS_STORAGE_KEY)).not.toBeNull();
  });

  it('falls back to localStorage when the chat folder cannot be read', async () => {
    storage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify([session('a', 1)]));
    bridge.loadChatSessions.mockRejectedValue(new Error('no app data dir'));
    expect((await loadStoredSessions()).sessions.map((s) => s.id)).toEqual(['a']);
  });

  it('loads only once per app start', async () => {
    await Promise.all([loadStoredSessions(), loadStoredSessions()]);
    expect(bridge.loadChatSessions).toHaveBeenCalledTimes(1);
  });
});

describe('sessionStore', () => {
  it('writes one file per chat without image data', async () => {
    const s = session('a', 1);
    s.messages[0].images = [{ id: 'i', name: 'x.png', mediaType: 'image/png', data: 'QUJD' }];
    await sessionStore().save(s);
    const [id, json] = bridge.saveChatSession.mock.calls[0];
    expect(id).toBe('a');
    expect(JSON.parse(json).messages[0].images).toEqual([{ id: 'i', name: 'x.png', mediaType: 'image/png' }]);
  });

  it('uses localStorage outside the desktop app', async () => {
    env.tauri = false;
    const store = sessionStore();
    await store.save(session('a', 1));
    await store.save(session('b', 2));
    await store.save(session('a', 1, 'edited'));
    await store.remove('b');
    const saved = JSON.parse(storage.getItem(SESSIONS_STORAGE_KEY)!);
    expect(saved.map((s: ChatSession) => [s.id, s.messages[0].content])).toEqual([['a', 'edited']]);
    expect(bridge.saveChatSession).not.toHaveBeenCalled();
  });
});
