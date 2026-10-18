import type { ToolCallRecord } from '../types/agent';

/** `step` = จำนวนกลุ่ม tool ก่อนหน้า ใช้ทำ React key ที่คงที่ระหว่างสตรีม */
export type MessageSegment =
  | { kind: 'thought'; text: string; step: number }
  | { kind: 'text'; text: string; step: number }
  | { kind: 'tools'; tools: ToolCallRecord[]; step: number };

/**
 * แบ่งข้อความ assistant เป็นลำดับเหตุการณ์จริงของแต่ละ step: ความคิด → ข้อความ → กลุ่ม tool → ...
 * โดยใช้ตำแหน่งที่ tool เริ่ม (contentOffset / thoughtOffset)
 * เช่น [คิด] "กำลังหยุด server:" → [tool] → [คิด] "หยุดแล้ว" — ให้เห็นว่า AI คิด/บอกอะไรก่อนรันแต่ละคำสั่ง
 * tool จาก session เก่าที่ไม่มี offset: ความคิดทั้งหมดอยู่ก่อน tool และข้อความอยู่หลัง (เหมือนเดิม)
 */
export function buildMessageSegments(content: string, tools: ToolCallRecord[], thought = ''): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let textPos = 0;
  let thoughtPos = 0;
  let step = 0;

  const pushThought = (end: number) => {
    const text = thought.slice(thoughtPos, end);
    if (text.trim()) segments.push({ kind: 'thought', text, step });
    thoughtPos = end;
  };
  const pushText = (end: number) => {
    const text = content.slice(textPos, end);
    if (text.trim()) segments.push({ kind: 'text', text, step });
    textPos = end;
  };

  for (const tool of tools) {
    const textOffset = Math.min(Math.max(tool.contentOffset ?? 0, textPos), content.length);
    const thoughtOffset = Math.min(Math.max(tool.thoughtOffset ?? thought.length, thoughtPos), thought.length);
    pushThought(thoughtOffset);
    pushText(textOffset);
    const last = segments[segments.length - 1];
    if (last?.kind === 'tools') last.tools.push(tool);
    else segments.push({ kind: 'tools', tools: [tool], step: step++ });
  }
  pushThought(thought.length);
  pushText(content.length);
  return segments;
}
