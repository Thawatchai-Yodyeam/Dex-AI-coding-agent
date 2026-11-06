import type { HistoryFormat, NeutralMessage } from './types';

/**
 * ประวัติสนทนาถูกเก็บใน "รูปแบบ native" ของ provider ที่ใช้อยู่ (รวม tool call/result, thinking
 * block และ thought signature) เพื่อให้เทิร์นถัดไปเห็นบริบทครบ
 * จะแปลงเป็น text-only (NeutralMessage) เฉพาะตอนสลับ provider หรือโหลด session ที่บันทึกไว้
 */

/** ข้อความ user ที่ driver แบบ OpenAI แทรกเพื่อส่งรูปจาก tool (Chat Completions ใส่รูปใน tool message ไม่ได้) */
export const TOOL_IMAGES_NOTE = '[Images returned by the tool calls above]';
const REMOVED_IMAGE_NOTE = '[Older screenshot removed to save context]';
/** เก็บรูปจาก tool ไว้กี่รูปล่าสุด — รูปถูกส่งซ้ำทุก step จึงแพง */
const KEEP_TOOL_IMAGES = 3;

export function isToolImagesMessage(m: any): boolean {
  return m?.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'text' && m.content[0].text === TOOL_IMAGES_NOTE;
}

function textOfAnthropicContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n');
}

/** แปลง native → text-only ทิ้ง tool call/result และ thinking (ส่วนที่ provider อื่นอ่านไม่ได้) */
export function toNeutral(history: any[], format: HistoryFormat): NeutralMessage[] {
  const out: NeutralMessage[] = [];
  for (const m of history) {
    if (!m) continue;
    let role: NeutralMessage['role'] | null = null;
    let text: string;
    if (format === 'google') {
      role = m.role === 'model' ? 'assistant' : 'user';
      text = (m.parts ?? [])
        .filter((p: any) => typeof p?.text === 'string' && !p.thought)
        .map((p: any) => p.text)
        .join('');
    } else if (format === 'anthropic') {
      role = m.role === 'assistant' ? 'assistant' : 'user';
      text = textOfAnthropicContent(m.content);
    } else {
      if (isToolImagesMessage(m)) continue;
      if (m.role === 'user' || m.role === 'assistant') role = m.role;
      // ข้อความที่มีรูปเป็น content parts — เก็บเฉพาะส่วน text
      text = typeof m.content === 'string' ? m.content : textOfAnthropicContent(m.content);
    }
    if (role && text.trim()) out.push({ role, text });
  }
  return out;
}

/** แปลง text-only → native ของ provider ปลายทาง (รวมข้อความ role เดียวกันที่ติดกัน) */
export function fromNeutral(messages: NeutralMessage[], format: HistoryFormat): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (!m.text) continue;
    const last = out[out.length - 1];
    if (format === 'google') {
      const role = m.role === 'assistant' ? 'model' : 'user';
      if (last?.role === role) last.parts.push({ text: m.text });
      else out.push({ role, parts: [{ text: m.text }] });
    } else {
      if (last?.role === m.role && typeof last.content === 'string') last.content += `\n\n${m.text}`;
      else out.push({ role: m.role, content: m.text });
    }
  }
  // Anthropic และ Gemini ต้องเริ่มด้วย user
  if (format !== 'openai' && out.length > 0 && out[0].role !== 'user') {
    out.unshift(format === 'google' ? { role: 'user', parts: [{ text: '(continued conversation)' }] } : { role: 'user', content: '(continued conversation)' });
  }
  return out;
}

/** ข้อความนี้คือ "ข้อความที่ผู้ใช้พิมพ์" (ไม่ใช่ tool result ที่ถูกห่อเป็น role user) */
export function isUserTextTurn(m: any, format: HistoryFormat): boolean {
  if (!m || m.role !== 'user') return false;
  if (format === 'google') return !(m.parts ?? []).some((p: any) => p?.functionResponse);
  if (format === 'anthropic') {
    return typeof m.content === 'string' || !(m.content ?? []).some((b: any) => b?.type === 'tool_result');
  }
  return !isToolImagesMessage(m);
}

/**
 * งบขนาดประวัติ (ตัวอักษรโดยประมาณ ~100–130k token) — ต่ำกว่า context ของทุกโมเดลใน catalog
 * พอให้เหลือที่สำหรับ system prompt, tools และคำตอบ
 */
export const CONTEXT_BUDGET_CHARS = 400_000;
/** ล้างแล้วให้เหลือราว 60% ของงบ — ล้างทีละก้อนใหญ่ cache ของ Claude จะเสียไม่บ่อย */
const TRIM_TARGET_RATIO = 0.6;
/** ผล tool ล่าสุดกี่ตัวที่ไม่ล้างเด็ดขาด (step ปัจจุบันยังต้องใช้) */
const KEEP_RECENT_RESULTS = 8;
export const CLEARED_TOOL_RESULT = '[Old tool result cleared to save context. Re-run the tool if you still need it.]';

/** รูปหนึ่งรูปคิดราว 1.5k token ไม่ใช่ความยาว base64 */
const IMAGE_CHARS_ESTIMATE = 6_000;

/** base64 ของรูปตามรูปแบบของแต่ละค่าย: Claude `source.data`, OpenAI `image_url.url` (data URL), Gemini `inlineData.data` */
function isImagePayload(holder: any, key: string, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (key === 'data') return holder?.type === 'base64' || typeof holder?.mimeType === 'string';
  return key === 'url' && value.startsWith('data:image/');
}

/** ขนาดประวัติโดยประมาณ (ตัวอักษร) — นับรูปเป็นค่าคงที่แทนความยาว base64 */
export function estimateHistoryChars(history: any[]): number {
  let extra = 0;
  const json = JSON.stringify(history, function (this: any, key, value) {
    if (isImagePayload(this, key, value)) {
      extra += IMAGE_CHARS_ESTIMATE;
      return '';
    }
    return value;
  });
  return (json?.length ?? 0) + extra;
}

interface ResultSlot {
  size: number;
  clear: () => void;
}

/** ผล tool ที่ยังไม่ถูกล้าง เรียงจากเก่าไปใหม่ — clear() แทนเนื้อหาด้วยข้อความสั้น (คู่ call/result ยังครบ) */
function toolResultSlots(history: any[], format: HistoryFormat): ResultSlot[] {
  const slots: ResultSlot[] = [];
  // ผลที่มีรูปต้องนับรูปแบบเดียวกับ estimateHistoryChars ไม่ใช่ความยาว base64 ไม่งั้นนับว่าล้างไปเยอะเกินจริง
  const sizeOf = (v: unknown) => (typeof v === 'string' ? v.length : estimateHistoryChars([v ?? '']));
  for (const m of history) {
    if (format === 'openai') {
      if (m?.role === 'tool' && m.content !== CLEARED_TOOL_RESULT) {
        slots.push({ size: sizeOf(m.content), clear: () => (m.content = CLEARED_TOOL_RESULT) });
      }
    } else if (format === 'anthropic') {
      if (m?.role !== 'user' || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b?.type === 'tool_result' && b.content !== CLEARED_TOOL_RESULT) {
          slots.push({ size: sizeOf(b.content), clear: () => (b.content = CLEARED_TOOL_RESULT) });
        }
      }
    } else {
      for (const p of m?.parts ?? []) {
        const fr = p?.functionResponse;
        if (fr && fr.response?.result !== CLEARED_TOOL_RESULT) {
          slots.push({ size: sizeOf(fr.response), clear: () => (fr.response = { result: CLEARED_TOOL_RESULT }) });
        }
      }
    }
  }
  return slots;
}

/**
 * เหลือรูปจาก tool (screenshot) แค่ KEEP_TOOL_IMAGES รูปล่าสุด รูปเก่ากว่านั้นแทนด้วยข้อความสั้น
 * แก้ใน history ตรง ๆ โดยไม่ลบข้อความ คู่ call/result จึงยังครบ — คืนจำนวนรูปที่ถูกเอาออก
 */
export function dropOldToolImages(history: any[], format: HistoryFormat, keep = KEEP_TOOL_IMAGES): number {
  const slots: (() => void)[] = [];
  const replaceWithNote = (list: any[], index: number) => () => {
    list[index] = { type: 'text', text: REMOVED_IMAGE_NOTE };
  };
  for (const m of history) {
    if (format === 'anthropic') {
      if (m?.role !== 'user' || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b?.type !== 'tool_result' || !Array.isArray(b.content)) continue;
        b.content.forEach((part: any, i: number) => {
          if (part?.type === 'image') slots.push(replaceWithNote(b.content, i));
        });
      }
    } else if (format === 'google') {
      for (const p of m?.parts ?? []) {
        const fr = p?.functionResponse;
        if (fr && Array.isArray(fr.parts) && fr.parts.length > 0) slots.push(() => delete fr.parts);
      }
    } else if (isToolImagesMessage(m)) {
      m.content.forEach((part: any, i: number) => {
        if (part?.type === 'image_url') slots.push(replaceWithNote(m.content, i));
      });
    }
  }
  const drop = slots.slice(0, Math.max(0, slots.length - keep));
  for (const remove of drop) remove();
  return drop.length;
}

/**
 * ประวัติใหญ่เกินงบ → ล้างผล tool เก่าสุดก่อน (แก้ใน history ที่ส่งมาตรง ๆ) จนเหลือราว 60% ของงบ
 * ใช้ได้ทั้งตอนเริ่มเทิร์นและระหว่าง tool loop เพราะไม่ลบข้อความ คู่ call/result จึงไม่ขาด
 * คืนจำนวนผลที่ถูกล้าง
 */
export function trimToolResults(history: any[], format: HistoryFormat, budget = CONTEXT_BUDGET_CHARS): number {
  let size = estimateHistoryChars(history);
  if (size <= budget) return 0;
  const slots = toolResultSlots(history, format);
  const clearable = slots.slice(0, Math.max(0, slots.length - KEEP_RECENT_RESULTS));
  let cleared = 0;
  for (const slot of clearable) {
    if (size <= budget * TRIM_TARGET_RATIO) break;
    if (slot.size <= CLEARED_TOOL_RESULT.length) continue;
    slot.clear();
    size -= slot.size - CLEARED_TOOL_RESULT.length;
    cleared++;
  }
  return cleared;
}

/**
 * ถอด thinking block ทั้งหมดออกจากประวัติแบบ Claude — ใช้เมื่อสิ่งที่อยู่ก่อนหน้า block เปลี่ยน
 * (ตัดหัวประวัติ, ชุด tool เปลี่ยน) preserved thinking จะไม่รับ block เดิม แต่อนุญาตให้ถอดออกทั้งหมดได้
 */
export function stripThinking(history: any[]): any[] {
  return history
    .map((m) =>
      m.role === 'assistant' && Array.isArray(m.content)
        ? { ...m, content: m.content.filter((b: any) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking') }
        : m
    )
    .filter((m) => !(Array.isArray(m.content) && m.content.length === 0));
}

/** ตัดหัวประวัติที่ตำแหน่ง cut (ต้องเป็นขอบเทิร์น) — Claude ต้องถอด thinking ของข้อความที่เหลือด้วย */
export function cutAt(history: any[], format: HistoryFormat, cut: number): any[] {
  const kept = history.slice(cut);
  return format === 'anthropic' ? stripThinking(kept) : kept;
}

/**
 * ตัดประวัติเก่าเมื่อยาวเกิน โดยตัดได้เฉพาะ "ขอบเขตเทิร์น" (ข้อความที่ผู้ใช้พิมพ์)
 * เพื่อไม่ให้ tool_result/functionResponse หลุดไปไม่มีคู่ (ซึ่งทำให้ API ตอบ 400)
 */
export function pruneHistory(history: any[], format: HistoryFormat, maxMessages: number): any[] {
  if (history.length <= maxMessages) return history;
  let cut = history.length - maxMessages;
  while (cut < history.length && !isUserTextTurn(history[cut], format)) cut++;
  if (cut >= history.length) return history;
  return cutAt(history, format, cut);
}

/**
 * ใช้ตอนเริ่มเทิร์น: ล้างผล tool เก่าก่อน ถ้ายังเกินงบ (ข้อความล้วนยาวมาก) ค่อยตัดเทิร์นเก่าทิ้งทีละเทิร์น
 * ไม่ตัดเทิร์นล่าสุดเสมอ
 */
export function pruneHistoryToBudget(history: any[], format: HistoryFormat, budget = CONTEXT_BUDGET_CHARS): any[] {
  trimToolResults(history, format, budget);
  let size = estimateHistoryChars(history);
  if (size <= budget) return history;
  const turnStarts = history.flatMap((m, i) => (i > 0 && isUserTextTurn(m, format) ? [i] : []));
  let cut = 0;
  for (const start of turnStarts) {
    size -= estimateHistoryChars(history.slice(cut, start));
    cut = start;
    if (size <= budget * TRIM_TARGET_RATIO) break;
  }
  return cut > 0 ? cutAt(history, format, cut) : history;
}
