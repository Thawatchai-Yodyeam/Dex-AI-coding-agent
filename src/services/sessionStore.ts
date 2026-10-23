import { isTauri } from '@tauri-apps/api/core';
import type { ChatSession } from '../types/agent';
import { tauriBridge } from './tauriBridge';

/** ที่เก็บแบบเดิม (ทุกแชทใน key เดียว) — ใช้ตอนรันในเบราว์เซอร์ และเป็นต้นทางตอนย้ายแชทเก่าไปเป็นไฟล์ */
export const SESSIONS_STORAGE_KEY = 'dex_chat_sessions_v1';
export const ACTIVE_SESSION_STORAGE_KEY = 'dex_active_session_id';

export interface StoredSessions {
  /** ใหม่ไปเก่าตามเวลาที่สร้าง */
  sessions: ChatSession[];
  activeId: string | null;
}

/** ที่บันทึกแชท: ในแอปเป็นไฟล์ละแชทใน app data, ในเบราว์เซอร์ (vite dev) เป็น localStorage */
export interface SessionStore {
  save(session: ChatSession): Promise<void>;
  remove(sessionId: string): Promise<void>;
}

function isSession(value: unknown): value is ChatSession {
  const s = value as ChatSession | null;
  return !!s && typeof s.id === 'string' && Array.isArray(s.messages);
}

function parseSession(json: string): ChatSession | null {
  try {
    const parsed = JSON.parse(json);
    return isSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readLegacy(): ChatSession[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSIONS_STORAGE_KEY) || 'null');
    return Array.isArray(parsed) ? parsed.filter(isSession) : [];
  } catch (e) {
    console.error('Failed to read chat sessions from localStorage:', e);
    return [];
  }
}

/**
 * ไม่บันทึก base64 ของรูป — แชทถูกเขียนลงดิสก์ถี่ระหว่างสตรีม รูปหลาย MB จะทำให้ช้า
 * (agent ยังเห็นรูปจากประวัติ native ที่บันทึกแยก)
 */
export function stripImageData(session: ChatSession): ChatSession {
  if (!session.messages.some((m) => m.images?.some((i) => i.data))) return session;
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.images ? { ...m, images: m.images.map(({ data: _data, ...rest }) => rest) } : m
    ),
  };
}

const fileStore: SessionStore = {
  save: (session) => tauriBridge.saveChatSession(session.id, JSON.stringify(stripImageData(session))),
  remove: (sessionId) => tauriBridge.deleteChatSession(sessionId),
};

const localStore: SessionStore = {
  async save(session) {
    const others = readLegacy().filter((s) => s.id !== session.id);
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify([stripImageData(session), ...others]));
  },
  async remove(sessionId) {
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(readLegacy().filter((s) => s.id !== sessionId)));
  },
};

export function sessionStore(): SessionStore {
  return isTauri() ? fileStore : localStore;
}

/**
 * อ่านไฟล์แชททั้งหมด และย้ายแชทเก่าจาก localStorage ไปเป็นไฟล์ (ลบของเก่าเมื่อย้ายครบทุกแชทแล้วเท่านั้น)
 * อ่านไฟล์ไม่ได้ → ใช้ของใน localStorage ไปก่อน
 */
async function loadOnce(): Promise<StoredSessions> {
  const legacy = readLegacy();
  let sessions = legacy;
  if (isTauri()) {
    try {
      const files = (await tauriBridge.loadChatSessions()).map(parseSession).filter(isSession);
      const known = new Set(files.map((s) => s.id));
      const toMigrate = legacy.filter((s) => !known.has(s.id));
      const results = await Promise.allSettled(toMigrate.map((s) => fileStore.save(s)));
      if (legacy.length > 0 && results.every((r) => r.status === 'fulfilled')) {
        localStorage.removeItem(SESSIONS_STORAGE_KEY);
      }
      sessions = [...files, ...toMigrate];
    } catch (e) {
      console.error('Failed to load chat sessions from disk:', e);
    }
  }
  sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return { sessions, activeId: localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY) };
}

let loading: Promise<StoredSessions> | null = null;

/** โหลดครั้งเดียวต่อการเปิดแอป (StrictMode เรียก effect ซ้ำ — ต้องไม่ย้ายข้อมูลสองรอบ) */
export function loadStoredSessions(): Promise<StoredSessions> {
  loading ??= loadOnce();
  return loading;
}

/** สำหรับเทสต์ */
export function resetSessionLoader() {
  loading = null;
}
