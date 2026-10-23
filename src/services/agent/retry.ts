import { AgentAbortError } from './types';

/** สถานะที่เป็นปัญหาชั่วคราวฝั่ง API: timeout, rate limit, server error, 529 = Anthropic overloaded */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

export const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1000;
const MAX_BACKOFF_MS = 20_000;
/** retry-after ที่ API บอกมาเชื่อได้ แต่ไม่รอเกินนี้ */
const MAX_RETRY_AFTER_MS = 60_000;

export interface RetryInfo {
  /** ครั้งที่กำลังจะลองใหม่ (เริ่ม 1) */
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}

/** error ที่ลองใหม่ได้ พร้อม retry-after (วินาทีหรือวันที่ ตามที่ header ส่งมา) */
export class TransientApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfter?: string | null
  ) {
    super(message);
    this.name = 'TransientApiError';
  }
}

/** แปลง response ที่ไม่ ok เป็น Error — ถ้าเป็นสถานะชั่วคราวจะได้ TransientApiError */
export async function httpError(label: string, response: Response): Promise<Error> {
  const message = `${label} [${response.status}]: ${await response.text().catch(() => '')}`;
  return RETRYABLE_STATUS.has(response.status)
    ? new TransientApiError(message, response.status, response.headers.get('retry-after'))
    : new Error(message);
}

export function isRetryableError(err: unknown): boolean {
  if (!err || err instanceof AgentAbortError || (err as any).name === 'AbortError') return false;
  if (err instanceof TransientApiError) return true;
  // SDK ของ Gemini โยน ApiError ที่มี status เป็นตัวเลข
  const status = (err as any).status;
  if (typeof status === 'number') return RETRYABLE_STATUS.has(status);
  // fetch / การอ่านสตรีมล้มเพราะเครือข่าย (WebView2: "Failed to fetch", "network error")
  return err instanceof TypeError && /fetch|network|load failed/i.test(err.message);
}

export function retryDelayMs(attempt: number, retryAfter?: string | null, random = Math.random): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.min(Math.max(0, at - Date.now()), MAX_RETRY_AFTER_MS);
  }
  // exponential backoff + jitter ±25% กันหลาย request ยิงพร้อมกันอีกรอบ
  const base = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.round(base * (0.75 + random() * 0.5));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AgentAbortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AgentAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * รัน `run` ซ้ำเมื่อเจอ error ชั่วคราว — `run` ต้องเริ่มใหม่จากศูนย์ได้ทุกครั้ง
 * (driver ใช้ครอบทั้ง request + การอ่านสตรีมของหนึ่ง step จึงลองใหม่ได้แม้สตรีมขาดกลางทาง)
 */
export async function withRetry<T>(
  run: (attempt: number) => Promise<T>,
  opts: { signal?: AbortSignal; onRetry?: (info: RetryInfo) => void } = {}
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run(attempt);
    } catch (err) {
      if (opts.signal?.aborted) throw new AgentAbortError();
      if (attempt >= MAX_RETRIES || !isRetryableError(err)) throw err;
      const delayMs = retryDelayMs(attempt, err instanceof TransientApiError ? err.retryAfter : null);
      opts.onRetry?.({
        attempt: attempt + 1,
        maxAttempts: MAX_RETRIES,
        delayMs,
        reason: (err as Error)?.message?.slice(0, 200) || String(err),
      });
      await sleep(delayMs, opts.signal);
    }
  }
}
