import type {
  AppSettings,
  ApprovalDecision,
  ImageAttachment,
  PermissionRule,
  ToolCallRecord,
  TokenUsage,
} from '../../types/agent';
import type { RetryInfo } from './retry';

export interface AgentCallbacks {
  onTextChunk: (chunk: string, fullText: string) => void;
  onThoughtChunk?: (chunk: string, fullThought: string) => void;
  onToolStart: (tool: ToolCallRecord) => void;
  onToolUpdate: (tool: ToolCallRecord) => void;
  onRequestApproval: (tool: ToolCallRecord) => Promise<ApprovalDecision>;
  /** ผู้ใช้กด "อนุญาตเสมอ" — UI บันทึกกฎลง settings */
  onAddPermissionRule?: (rule: PermissionRule) => void;
  /**
   * ก่อน agent เขียน/แก้ไฟล์ — `original` = เนื้อหาเดิม (null = ไฟล์ใหม่)
   * `undefined` = เก็บ checkpoint ไม่ได้ (ไฟล์ใหญ่/ไม่ใช่ข้อความ)
   */
  onFileCheckpoint?: (path: string, original: string | null | undefined) => void;
  /** ก่อนรันคำสั่ง shell ที่ไม่ใช่แบบอ่านอย่างเดียว — UI ถือโอกาส snapshot workspace ไว้ย้อน */
  onBeforeShellCommand?: () => Promise<void>;
  /** API ล้มชั่วคราว กำลังรอลองใหม่ — ข้อความของ step นั้นจะถูกส่งมาใหม่ตั้งแต่ต้นผ่าน onTextChunk */
  onRetry?: (info: RetryInfo) => void;
  /**
   * ประวัติใกล้เต็มตอนเริ่มเทิร์น: 'start' = กำลังให้โมเดลสรุปเทิร์นเก่า, 'done' = แทนด้วยสรุปแล้ว,
   * 'skipped' = สรุปไม่ได้/ไม่มีอะไรให้สรุป (ล้างผล tool และตัดเทิร์นเก่าแบบเดิมแทน)
   */
  onCompaction?: (phase: 'start' | 'done' | 'skipped') => void;
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

/** สิ่งที่ผู้ใช้ส่งในหนึ่งเทิร์น */
export interface UserInput {
  text: string;
  images?: ImageAttachment[];
}

/** รูปที่มี data จริง (ข้อความที่โหลดจาก localStorage จะไม่มี data) */
export function imagesWithData(input: UserInput): Required<ImageAttachment>[] {
  return (input.images ?? []).filter((i): i is Required<ImageAttachment> => !!i.data);
}

/** ผลลัพธ์ของ provider driver หนึ่งเทิร์น (อาจมีหลาย tool step) */
export interface TurnResult {
  text: string;
  usage: TokenUsage;
}

/** รูปที่ tool ส่งกลับ (เช่น screenshot ของ browser) — base64 ไม่มี prefix */
export interface ToolImage {
  mediaType: string;
  data: string;
}

/** key ในผลของ tool ที่เก็บรูป — driver แยกออกไปแนบตามรูปแบบของแต่ละค่าย ไม่ให้ base64 ไปปนในข้อความ */
export const TOOL_IMAGES_KEY = 'images__';

/** แยกรูปออกจากผลของ tool */
export function takeToolImages(result: unknown): { result: unknown; images: ToolImage[] } {
  if (!result || typeof result !== 'object' || !(TOOL_IMAGES_KEY in result)) return { result, images: [] };
  const { [TOOL_IMAGES_KEY]: images, ...rest } = result as Record<string, unknown>;
  return { result: rest, images: Array.isArray(images) ? (images as ToolImage[]) : [] };
}

/** tool หนึ่งตัวในรูป JSON Schema กลาง — driver แปลงเป็นรูปแบบของแต่ละค่าย */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** สิ่งที่ driver ทุกตัวได้รับ — history เป็นรูปแบบ native ของ provider นั้น และ driver จะ push ต่อท้ายเอง */
export interface TurnContext {
  settings: AppSettings;
  apiKey: string;
  history: any[];
  /** tool ของเทิร์นนี้: ชุดพื้นฐาน + use_skill (ถ้ามี skill) + tool จาก MCP server ที่เชื่อมต่ออยู่ */
  tools: readonly ToolDefinition[];
  callbacks: AgentCallbacks;
  signal?: AbortSignal;
  systemPrompt: string;
  runTool: (name: string, args: Record<string, any>) => Promise<unknown>;
  /** เรียกก่อนทุก step (เริ่ม 0) — false = ผู้ใช้ให้หยุดที่เพดาน step, driver ต้องปิดเทิร์นเอง */
  shouldContinue?: (step: number) => Promise<boolean>;
}

/** ข้อความที่ driver ใส่ท้ายคำตอบเมื่อผู้ใช้ให้หยุดที่เพดาน step */
export function stepLimitNote(language: string, steps: number): string {
  return language === 'en'
    ? `*(Stopped after ${steps} steps at your request.)*`
    : `*(หยุดหลังทำไป ${steps} รอบตามที่คุณเลือก)*`;
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
  if (step.cachedTokens) total.cachedTokens = (total.cachedTokens ?? 0) + step.cachedTokens;
}

/**
 * ข้อความของ step ใหม่ (หลังรัน tool) ต้องคั่นจากข้อความของ step ก่อนด้วยบรรทัดว่าง
 * ไม่งั้น "กำลังหยุด server:" กับ "หยุดแล้ว" จะติดกันเป็นประโยคเดียว
 */
export function appendStepText(fullText: string, piece: string, stepHasText: boolean): string {
  const sep = !stepHasText && fullText && !fullText.endsWith('\n\n') ? '\n\n' : '';
  return fullText + sep + piece;
}
