import type { ToolDefinition } from '../agent/types';
import type { McpServerStatus } from './manager';

/**
 * ขนาดของ tool ที่ส่งให้โมเดล: schema ทุกตัวถูกส่งซ้ำในทุกคำขอของ tool loop และคิดเงินเป็น input token
 * ตัวเลขเป็นค่าประมาณจากความยาว JSON ไม่ใช่ tokenizer ของค่าย ใช้ตัดสินใจคร่าว ๆ ว่าควรปิดตัวไหน
 */

/** งบประวัติใน history.ts ใช้ราว 3–4 ตัวอักษรต่อ token เช่นกัน */
const CHARS_PER_TOKEN = 3.5;

/** เอกสาร tool search ของ Claude: ถ้า definition รวมเกิน 10k token ควรเลิกโหลดทั้งหมดตั้งแต่ต้น */
export const TOOL_TOKENS_WARN_AT = 10_000;
/** เอกสารเดียวกัน: ความแม่นในการเลือก tool ลดลงเมื่อเกิน 30–50 ตัว — ใช้ขอบบนเพื่อไม่ให้เตือนบ่อยจนคนเลิกอ่าน */
export const TOOL_COUNT_WARN_AT = 50;

/** ตัวอักษรนอก ASCII (ไทย จีน ฯลฯ) ใช้ราว 1 token ต่อตัวอักษร ไม่ใช่ 3–4 ตัวอักษรต่อ token */
export function estimateToolTokens(tool: ToolDefinition): number {
  const json = JSON.stringify(tool);
  const wide = json.match(/[\u0080-￿]/g)?.length ?? 0;
  return Math.ceil((json.length - wide) / CHARS_PER_TOKEN) + wide;
}

export interface ToolUsageSummary {
  mcpTools: number;
  mcpTokens: number;
  builtInTools: number;
  builtInTokens: number;
  totalTools: number;
  totalTokens: number;
  /** tool ของ plugin มากจนน่าจะมีผลกับค่าใช้จ่ายหรือความแม่นในการเลือก tool */
  isHigh: boolean;
}

/** นับเฉพาะ tool ที่จะส่งให้โมเดลจริง: server ที่พร้อมใช้ และ tool ที่ไม่ถูกปิด */
export function summarizeToolUsage(statuses: readonly McpServerStatus[], builtIn: readonly ToolDefinition[]): ToolUsageSummary {
  const enabled = statuses.flatMap((status) => (status.state === 'ready' ? status.toolInfo.filter((tool) => tool.enabled) : []));
  const mcpTokens = enabled.reduce((sum, tool) => sum + tool.tokens, 0);
  const builtInTokens = builtIn.reduce((sum, tool) => sum + estimateToolTokens(tool), 0);
  const totalTools = builtIn.length + enabled.length;
  return {
    mcpTools: enabled.length,
    mcpTokens,
    builtInTools: builtIn.length,
    builtInTokens,
    totalTools,
    totalTokens: builtInTokens + mcpTokens,
    isHigh: enabled.length > 0 && (mcpTokens >= TOOL_TOKENS_WARN_AT || totalTools > TOOL_COUNT_WARN_AT),
  };
}
