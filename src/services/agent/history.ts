import type { HistoryFormat, NeutralMessage } from './types';

/**
 * ประวัติสนทนาถูกเก็บใน "รูปแบบ native" ของ provider ที่ใช้อยู่ (รวม tool call/result, thinking
 * block และ thought signature) เพื่อให้เทิร์นถัดไปเห็นบริบทครบ
 * จะแปลงเป็น text-only (NeutralMessage) เฉพาะตอนสลับ provider หรือโหลด session ที่บันทึกไว้
 */

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
    let text = '';
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
  return true;
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
  const kept = history.slice(cut);
  if (format === 'anthropic') {
    // ประวัติถูกแก้ (ตัดหัว) → thinking block เดิมใช้ต่อไม่ได้ (preserved thinking ตรวจลำดับ)
    // จึงถอด thinking ออกจากข้อความ assistant ที่เหลือ
    return kept.map((m) =>
      m.role === 'assistant' && Array.isArray(m.content)
        ? { ...m, content: m.content.filter((b: any) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking') }
        : m
    ).filter((m) => !(Array.isArray(m.content) && m.content.length === 0));
  }
  return kept;
}
