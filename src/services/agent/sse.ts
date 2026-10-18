import { throwIfAborted } from './types';

/**
 * อ่าน Server-Sent Events จาก fetch Response ทีละ `data:` payload
 * - จัดการ chunk ที่ถูกตัดกลางบรรทัด
 * - flush บรรทัดสุดท้ายที่ค้างใน buffer หลังสตรีมจบ (usage chunk สุดท้ายมักอยู่ตรงนี้)
 * - หยุดอ่านทันทีเมื่อเจอ `[DONE]`
 */
export async function* readSseData(response: Response, signal?: AbortSignal): AsyncGenerator<string> {
  if (!response.body) throw new Error('Response has no readable stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const parseLine = (line: string): string | null => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return null;
    return trimmed.slice(5).trim();
  };

  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const data = parseLine(line);
        if (data === null) continue;
        if (data === '[DONE]') return;
        yield data;
      }
    }
    buffer += decoder.decode();
    const tail = parseLine(buffer);
    if (tail && tail !== '[DONE]') yield tail;
  } finally {
    reader.releaseLock();
  }
}

/** JSON.parse ที่คืน null แทนการ throw (chunk keep-alive / comment) */
export function tryParseJson(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
