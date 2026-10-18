import type { AppSettings, ApprovalDecision, PermissionRule, ToolCallRecord, TokenUsage } from '../../types/agent';

export interface AgentCallbacks {
  onTextChunk: (chunk: string, fullText: string) => void;
  onThoughtChunk?: (chunk: string, fullThought: string) => void;
  onToolStart: (tool: ToolCallRecord) => void;
  onToolUpdate: (tool: ToolCallRecord) => void;
  onRequestApproval: (tool: ToolCallRecord) => Promise<ApprovalDecision>;
  /** ผู้ใช้กด "อนุญาตเสมอ" — UI บันทึกกฎลง settings */
  onAddPermissionRule?: (rule: PermissionRule) => void;
}

/** ที่มาของกฎสิทธิ์ระหว่างรัน tool — กฎถาวรใน settings + กฎ "ตลอดแชทนี้" ที่อยู่ในหน่วยความจำ */
export interface PermissionStore {
  rules: () => readonly PermissionRule[];
  addRule: (rule: Pick<PermissionRule, 'tool' | 'pattern'>, scope: 'session' | 'always') => void;
}

export interface AgentResponseResult {
  text: string;
  tokenUsage: TokenUsage;
  durationMs: number;
}

/** ผลลัพธ์ของ provider driver หนึ่งเทิร์น (อาจมีหลาย tool step) */
export interface TurnResult {
  text: string;
  usage: TokenUsage;
}

/** สิ่งที่ driver ทุกตัวได้รับ — history เป็นรูปแบบ native ของ provider นั้น และ driver จะ push ต่อท้ายเอง */
export interface TurnContext {
  settings: AppSettings;
  apiKey: string;
  history: any[];
  callbacks: AgentCallbacks;
  signal?: AbortSignal;
  systemPrompt: string;
  runTool: (name: string, args: Record<string, any>) => Promise<unknown>;
}

export type HistoryFormat = 'google' | 'anthropic' | 'openai';

/** ข้อความกลางแบบ text-only ใช้ตอนสลับ provider หรือกู้ประวัติจาก session ที่บันทึกไว้ */
export interface NeutralMessage {
  role: 'user' | 'assistant';
  text: string;
}

export class AgentAbortError extends Error {
  constructor() {
    super('Aborted by user');
    this.name = 'AgentAbortError';
  }
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new AgentAbortError();
}

export function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function addUsage(total: TokenUsage, step: TokenUsage) {
  total.promptTokens += step.promptTokens;
  total.completionTokens += step.completionTokens;
  total.totalTokens += step.totalTokens || step.promptTokens + step.completionTokens;
}

/**
 * ข้อความของ step ใหม่ (หลังรัน tool) ต้องคั่นจากข้อความของ step ก่อนด้วยบรรทัดว่าง
 * ไม่งั้น "กำลังหยุด server:" กับ "หยุดแล้ว" จะติดกันเป็นประโยคเดียว
 */
export function appendStepText(fullText: string, piece: string, stepHasText: boolean): string {
  const sep = !stepHasText && fullText && !fullText.endsWith('\n\n') ? '\n\n' : '';
  return fullText + sep + piece;
}
