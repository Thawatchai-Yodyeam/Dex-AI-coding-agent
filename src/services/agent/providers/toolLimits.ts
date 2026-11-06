import { PROVIDERS_CATALOG, type AIProvider } from '../../../types/agent';
import { translations } from '../../../utils/i18n';
import { TransientApiError } from '../retry';
import { MCP_TOOL_PREFIX } from '../tools';
import { AgentAbortError, type TurnContext, type TurnResult, type UserInput } from '../types';

/**
 * เพดานจำนวน tool ต่อคำขอ ตรวจล่าสุด พ.ย. 2026 — เก็บเฉพาะตัวเลขที่มีที่มาอ้างอิงได้
 *
 * - google 512: `Tool.functionDeclarations` ใน @google/genai ระบุ "Maximum 512 function declarations" และ API ตอบ
 *   "At most 512 function declarations can be specified" (เอกสาร Google Cloud ระบุ 128 แต่เป็นของ Agent Platform ซึ่ง Dex ไม่ได้เรียก)
 * - openai 128: API reference ปัจจุบันไม่ระบุสำหรับ `tools` แต่ API ยังตอบ "Invalid 'tools': array too long ... maximum length 128"
 * - anthropic, deepseek, qwen: เอกสารปัจจุบันไม่ระบุเพดาน (Anthropic ระบุเฉพาะ deferred tools 10,000 ตัว ซึ่ง Dex ไม่ได้ใช้)
 * - custom: แล้วแต่ endpoint
 *
 * ค่ายที่ไม่มีตัวเลข และกรณีที่ค่ายเปลี่ยนเพดานในภายหลัง ใช้คำตอบของ API เป็นหลักเสมอ:
 * Dex ไม่ปฏิเสธคำขอล่วงหน้าเอง แต่แปล error ของ API เป็นข้อความที่บอกวิธีแก้ (ดู explainToolLimitError)
 * ตารางนี้ใช้เตือนในหน้า Customizations ก่อนผู้ใช้ส่งข้อความ
 */
const TOOL_LIMITS: Partial<Record<AIProvider, number>> = { google: 512, openai: 128 };

export function toolLimitOf(provider: AIProvider): number | null {
  return TOOL_LIMITS[provider] ?? null;
}

const TOOLS = '(?:tools|functions|function[ _]declarations)';

/** ข้อความที่บอกชัดว่าเกินเพดาน — ระวังไม่ให้ไปโดน error ของ tool รายตัว เช่น `tools[3].function.name: string too long` */
const TOOL_LIMIT_PATTERNS = [
  // OpenAI, Azure และ endpoint ที่เลียนแบบ: Invalid 'tools': array too long. Expected an array with maximum length 128 ...
  new RegExp(`\\b${TOOLS}['"\`\\\\]*\\s*(?::|is)?\\s*(?:an?\\s+)?(?:array\\s+)?too long`, 'i'),
  // Gemini: At most 512 function declarations can be specified
  new RegExp(`\\bat most \\d+ ${TOOLS}\\b`, 'i'),
  new RegExp(`\\btoo many ${TOOLS}\\b`, 'i'),
  new RegExp(`\\b(?:maximum|max|limit)(?: number)? of \\d+ ${TOOLS}\\b`, 'i'),
  new RegExp(`\\bnumber of ${TOOLS}\\b[^.\\n]{0,60}\\b(?:exceed|more than|greater than|maximum|limit)`, 'i'),
  // แบบ schema validation: tools: List should have at most 128 items
  new RegExp(`\\b${TOOLS}['"\`\\\\]*\\s*:[^.\\n]{0,40}\\bat most \\d+ items\\b`, 'i'),
  // Gemini คอมไพล์ schema ทุกตัวรวมกัน พอใหญ่เกินจะตอบแบบนี้ แม้จำนวนยังไม่ถึงเพดาน (Dex ไม่ได้ส่ง response schema)
  /too many states for serving/i,
];

const LIMIT_IN_MESSAGE = [/maximum length(?: is)? (\d+)/i, /at most (\d+)/i, /(?:maximum|max|limit)(?: number)? of (\d+)/i];

/**
 * 400 ที่ไม่บอกเหตุผลชัดเจน โทษ tool เฉพาะเมื่อส่งไปเยอะจริง: Gemini บางรุ่นตอบแค่ "Request contains an invalid argument"
 * เมื่อส่ง 239 ตัว ส่วน `"param":"tools"` คือ OpenAI ชี้ว่าทั้งรายการมีปัญหา (ไม่ใช่ `tools[3]...` ที่เป็นปัญหาของตัวเดียว)
 * 128 คือเพดานต่ำสุดที่มีที่มา — ต่ำกว่านี้ 400 แบบนี้น่าจะมาจากอย่างอื่น ต้องให้ผู้ใช้เห็นข้อความเดิม
 */
const SUSPECT_ABOVE = 128;
const VAGUE_REJECTION = /"param"\s*:\s*"tools"|request contains an invalid argument/i;

function isRejection(err: any, message: string): boolean {
  const status = typeof err?.status === 'number' ? err.status : Number(/\[(\d{3})\]/.exec(message)?.[1]);
  return status === 400 || status === 413 || status === 422;
}

function limitIn(message: string): number | null {
  for (const pattern of LIMIT_IN_MESSAGE) {
    const found = pattern.exec(message)?.[1];
    if (found) return Number(found);
  }
  return null;
}

/** error นี้เกิดจาก tool เยอะเกินไหม — ใช่ = คืนข้อความที่บอกวิธีแก้แทนข้อความดิบของ API, ไม่ใช่ = null */
export function explainToolLimitError(err: unknown, ctx: Pick<TurnContext, 'settings' | 'tools'>): Error | null {
  const count = ctx.tools.length;
  if (count === 0 || err instanceof AgentAbortError || err instanceof TransientApiError) return null;
  const message = String((err as any)?.message ?? err);
  const known = TOOL_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
  if (!known && !(count > SUSPECT_ABOVE && isRejection(err, message) && VAGUE_REJECTION.test(message))) return null;
  console.warn('The provider rejected the tool list:', message);

  const { language, provider } = ctx.settings;
  const t = translations[language === 'en' ? 'en' : 'th'];
  const providerName = PROVIDERS_CATALOG.find((p) => p.id === provider)?.name ?? provider;
  const limit = known ? limitIn(message) : null;
  // ข้อความบอกเพดานมาแต่จำนวนยังไม่เกิน = ไม่ใช่เพดานของจำนวน tool อย่าเอาไปบอกผู้ใช้
  const excess = limit !== null && count > limit ? count - limit : null;
  const mcpCount = ctx.tools.filter((tool) => tool.name.startsWith(MCP_TOOL_PREFIX)).length;
  const fix = mcpCount === 0 || (excess !== null && excess > mcpCount) ? t.toolLimitFixElsewhere : t.toolLimitFix(excess);
  return new Error(`${excess !== null ? t.toolLimitExceeded(providerName, limit!, count) : t.toolLimitLikely(providerName, count)} ${fix}`);
}

type TurnDriver = (ctx: TurnContext, input: UserInput) => Promise<TurnResult>;

/** ครอบ driver ของแต่ละค่าย: error ที่เกิดจากจำนวน tool ถึงมือผู้ใช้เป็นข้อความที่แก้เองได้ */
export function withToolLimitErrors(driver: TurnDriver): TurnDriver {
  return async (ctx, input) => {
    try {
      return await driver(ctx, input);
    } catch (err) {
      throw explainToolLimitError(err, ctx) ?? err;
    }
  };
}
