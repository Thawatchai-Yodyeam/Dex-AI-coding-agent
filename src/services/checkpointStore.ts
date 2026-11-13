import { isTauri } from '@tauri-apps/api/core';
import { tauriBridge } from './tauriBridge';

/**
 * checkpoint ที่เก่ากว่านี้ถูกทิ้งตอนโหลด — การย้อนเทิร์นเก่าเขียนทับงานที่ผู้ใช้ทำต่อจากนั้น
 * (git snapshot ย้อนทั้ง workspace) และ object ของ snapshot ที่ไม่มีใครอ้างถึงก็ถูก git gc เก็บกวาดราว 2 สัปดาห์
 */
export const CHECKPOINT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** เนื้อหาเดิมของไฟล์ก่อนเทิร์นหนึ่งแก้ (null = ไฟล์ใหม่) */
export interface TurnCheckpoint {
  sessionId: string;
  messageId: string;
  cwd: string;
  createdAt: number;
  originals: Map<string, string | null>;
  /**
   * git snapshot ก่อนคำสั่ง shell ตัวแรกของเทิร์น — ย้อนแล้วได้สภาพก่อน shell ทั้ง workspace
   * `pathsBefore` = ไฟล์ที่ tool แก้ไปก่อน snapshot (ต้องย้อนต่อจาก snapshot อีกชั้นถึงจะได้สภาพก่อนเทิร์น)
   */
  git?: { tree: string; pathsBefore: Set<string> };
  /** ไฟล์ลับ (.env ฯลฯ): เนื้อหาเดิมอยู่ในหน่วยความจำเท่านั้น ไม่เขียนลง app data */
  memoryOnly: Set<string>;
  /** checkpoint ที่โหลดจากดิสก์: ไฟล์ลับที่เนื้อหาเดิมไม่ได้ถูกบันทึกไว้ จึงย้อนไม่ได้แล้ว */
  lost: string[];
}

interface StoredCheckpoint {
  v: 1;
  sessionId: string;
  messageId: string;
  cwd: string;
  createdAt: number;
  originals: [string, string | null][];
  git?: { tree: string; pathsBefore: string[] };
  lost?: string[];
}

export function newCheckpoint(sessionId: string, messageId: string, cwd: string, now = Date.now()): TurnCheckpoint {
  return { sessionId, messageId, cwd, createdAt: now, originals: new Map(), memoryOnly: new Set(), lost: [] };
}

export function serializeCheckpoint(ckpt: TurnCheckpoint): string {
  const stored: StoredCheckpoint = {
    v: 1,
    sessionId: ckpt.sessionId,
    messageId: ckpt.messageId,
    cwd: ckpt.cwd,
    createdAt: ckpt.createdAt,
    originals: [...ckpt.originals].filter(([path]) => !ckpt.memoryOnly.has(path)),
    ...(ckpt.git ? { git: { tree: ckpt.git.tree, pathsBefore: [...ckpt.git.pathsBefore] } } : {}),
    lost: [...new Set([...ckpt.lost, ...ckpt.memoryOnly])],
  };
  return JSON.stringify(stored);
}

const isString = (v: unknown): v is string => typeof v === 'string';

/** null = ไฟล์เสีย/รุ่นที่ไม่รู้จัก */
export function parseCheckpoint(json: string): TurnCheckpoint | null {
  let raw: StoredCheckpoint;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (
    raw?.v !== 1 ||
    !isString(raw.sessionId) ||
    !isString(raw.messageId) ||
    !isString(raw.cwd) ||
    typeof raw.createdAt !== 'number' ||
    !Array.isArray(raw.originals)
  ) {
    return null;
  }
  const originals = new Map<string, string | null>();
  for (const entry of raw.originals) {
    if (!Array.isArray(entry) || !isString(entry[0]) || !(entry[1] === null || isString(entry[1]))) return null;
    originals.set(entry[0], entry[1]);
  }
  const git =
    raw.git && isString(raw.git.tree) && Array.isArray(raw.git.pathsBefore)
      ? { tree: raw.git.tree, pathsBefore: new Set(raw.git.pathsBefore.filter(isString)) }
      : undefined;
  return {
    sessionId: raw.sessionId,
    messageId: raw.messageId,
    cwd: raw.cwd,
    createdAt: raw.createdAt,
    originals,
    git,
    memoryOnly: new Set(),
    lost: Array.isArray(raw.lost) ? raw.lost.filter(isString) : [],
  };
}

// งานของแชทเดียวกันรันทีละงานตามลำดับ: เขียนไฟล์เดียวกันซ้อนกันแล้วตัวเก่าเสร็จทีหลังจะทับของใหม่
// และการลบต้องไม่ถูกงานเขียนที่ค้างอยู่สร้างไฟล์กลับมา
const chains = new Map<string, Promise<void>>();
const dirty = new Map<string, TurnCheckpoint>();

function enqueue(sessionId: string, job: () => Promise<void>): Promise<void> {
  const next = (chains.get(sessionId) ?? Promise.resolve())
    .then(job)
    .catch((e) => console.warn('Checkpoint store failed:', e));
  chains.set(sessionId, next);
  void next.then(() => {
    if (chains.get(sessionId) === next) chains.delete(sessionId);
  });
  return next;
}

const key = (ckpt: Pick<TurnCheckpoint, 'sessionId' | 'messageId'>) => `${ckpt.sessionId}/${ckpt.messageId}`;

/**
 * บันทึก checkpoint ลงดิสก์ — เรียกถี่ได้: เนื้อหาถูกอ่านจาก object ตอนเขียนจริง
 * การเรียกที่เข้ามาระหว่างรองานก่อนหน้าจึงรวมเป็นการเขียนครั้งเดียว
 */
export function saveCheckpoint(ckpt: TurnCheckpoint): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  const id = key(ckpt);
  dirty.set(id, ckpt);
  return enqueue(ckpt.sessionId, async () => {
    const latest = dirty.get(id);
    if (!latest) return;
    dirty.delete(id);
    await tauriBridge.saveCheckpoint(latest.sessionId, latest.messageId, serializeCheckpoint(latest));
  });
}

export function deleteCheckpoint(ckpt: Pick<TurnCheckpoint, 'sessionId' | 'messageId'>): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  dirty.delete(key(ckpt));
  return enqueue(ckpt.sessionId, () => tauriBridge.deleteCheckpoint(ckpt.sessionId, ckpt.messageId));
}

/** ลบ checkpoint ทั้งแชท (ตอนลบหรือล้างแชท) */
export function deleteSessionCheckpoints(sessionId: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  for (const id of [...dirty.keys()]) if (id.startsWith(`${sessionId}/`)) dirty.delete(id);
  return enqueue(sessionId, () => tauriBridge.deleteCheckpoints(sessionId));
}

/** checkpoint ที่ยังใช้ได้ของแชท — ไฟล์ที่เสีย หมดอายุ หรือไม่ใช่ของแชทนี้ถูกข้าม (ที่หมดอายุถูกลบทิ้ง) */
export async function loadCheckpoints(sessionId: string, now = Date.now()): Promise<TurnCheckpoint[]> {
  if (!isTauri()) return [];
  // รองานเขียน/ลบที่ค้างอยู่ก่อน จะได้ไม่อ่านของที่กำลังถูกลบ
  await chains.get(sessionId);
  const loaded: TurnCheckpoint[] = [];
  for (const json of await tauriBridge.loadCheckpoints(sessionId)) {
    const ckpt = parseCheckpoint(json);
    if (!ckpt || ckpt.sessionId !== sessionId) continue;
    if (now - ckpt.createdAt > CHECKPOINT_MAX_AGE_MS) {
      void deleteCheckpoint(ckpt);
      continue;
    }
    loaded.push(ckpt);
  }
  return loaded;
}
