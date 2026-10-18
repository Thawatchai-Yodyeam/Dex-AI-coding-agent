export type AIProvider = 'google' | 'anthropic' | 'openai' | 'deepseek' | 'qwen';

/** ระดับการคิดทั้งหมดที่ค่ายต่าง ๆ ใช้ — แต่ละโมเดลรองรับแค่บางระดับ (ดู ProviderModel.efforts) */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const REASONING_EFFORTS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** ธีมสีโปเกมอน — ใช้ค่าเดียวกับ <html data-theme> */
export type PokemonTheme = 'pikachu' | 'pokeball' | 'squirtle' | 'bulbasaur' | 'gengar';

export const POKEMON_THEMES: PokemonTheme[] = ['pikachu', 'pokeball', 'squirtle', 'bulbasaur', 'gengar'];

export type ThemePreference = 'system' | 'light' | 'dark' | PokemonTheme;

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ProviderModel {
  id: string;
  name: string;
  /** ระดับการคิดที่ API ของโมเดลนี้รับ เรียงจากน้อยไปมาก */
  efforts: ReasoningEffort[];
  defaultEffort: ReasoningEffort;
  isDefault?: boolean;
}

export interface ProviderInfo {
  id: AIProvider;
  name: string;
  badge: string;
  defaultBaseUrl?: string;
  models: ProviderModel[];
  /** false = API ของค่ายนี้รับรูปภาพไม่ได้ */
  vision?: boolean;
}

const CLAUDE_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const GPT_EFFORTS: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh'];
const GEMINI_FLASH_EFFORTS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];
const DEEPSEEK_EFFORTS: ReasoningEffort[] = ['none', 'low', 'high', 'max'];

/** รายชื่อโมเดล ณ ต.ค. 2026 — ID ต้องตรงกับที่ API ของแต่ละค่ายรับ */
export const PROVIDERS_CATALOG: ProviderInfo[] = [
  {
    id: 'google',
    name: 'Google Gemini',
    badge: 'Gemini',
    models: [
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: GEMINI_FLASH_EFFORTS, defaultEffort: 'medium', isDefault: true },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (Preview)', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
      { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', efforts: GEMINI_FLASH_EFFORTS, defaultEffort: 'medium' },
      { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite (เร็ว/ถูก)', efforts: GEMINI_FLASH_EFFORTS, defaultEffort: 'minimal' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    badge: 'Claude',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    models: [
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: CLAUDE_EFFORTS, defaultEffort: 'high', isDefault: true },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: CLAUDE_EFFORTS, defaultEffort: 'medium' },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5 (เร็ว/ถูก)', efforts: ['none', ...CLAUDE_EFFORTS], defaultEffort: 'medium' },
      { id: 'claude-fable-5-1', name: 'Claude Fable 5.1 (เก่งที่สุด)', efforts: CLAUDE_EFFORTS, defaultEffort: 'high' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI GPT',
    badge: 'GPT',
    defaultBaseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: GPT_EFFORTS, defaultEffort: 'medium', isDefault: true },
      { id: 'gpt-6-astra', name: 'GPT-6 Astra (Reasoning)', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
      { id: 'gpt-6-luna', name: 'GPT-6 Luna (เร็ว/ถูก)', efforts: GPT_EFFORTS, defaultEffort: 'low' },
      { id: 'gpt-5.5', name: 'GPT-5.5', efforts: GPT_EFFORTS, defaultEffort: 'medium' },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    badge: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    vision: false,
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', efforts: DEEPSEEK_EFFORTS, defaultEffort: 'high', isDefault: true },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', efforts: DEEPSEEK_EFFORTS, defaultEffort: 'high' },
    ],
  },
  {
    id: 'qwen',
    name: 'Alibaba Qwen',
    badge: 'Qwen',
    defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen3.8-max', name: 'Qwen3.8 Max', efforts: ['none', 'low', 'medium', 'xhigh'], defaultEffort: 'medium', isDefault: true },
      { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash (เร็ว/ถูก)', efforts: ['none', 'low', 'medium', 'high'], defaultEffort: 'medium' },
      { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', efforts: ['none', 'low', 'medium', 'high'], defaultEffort: 'medium' },
    ],
  },
];

export function supportsImages(provider: AIProvider): boolean {
  return PROVIDERS_CATALOG.find((p) => p.id === provider)?.vision !== false;
}

export function findModel(provider: AIProvider, modelId: string): ProviderModel | undefined {
  return PROVIDERS_CATALOG.find((p) => p.id === provider)?.models.find((m) => m.id === modelId);
}

/** effort ที่จะส่งจริง: ค่าที่ผู้ใช้เลือกถ้าโมเดลรองรับ ไม่งั้นใช้ค่าเริ่มต้นของโมเดล */
export function effectiveEffort(settings: Pick<AppSettings, 'provider' | 'model' | 'reasoningEffort'>): ReasoningEffort {
  const model = findModel(settings.provider, settings.model);
  if (!model) return settings.reasoningEffort;
  return model.efforts.includes(settings.reasoningEffort) ? settings.reasoningEffort : model.defaultEffort;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, any>;
  status: 'pending_approval' | 'running' | 'completed' | 'failed' | 'rejected';
  output?: string;
  error?: string;
  exitCode?: number;
  /** เหตุผลที่ต้องขออนุมัติ (เช่น ไฟล์ลับ, คำสั่งลบไฟล์) แสดงบนแถบอนุมัติ */
  approvalReason?: ApprovalReason;
  /** กฎที่จะบันทึกถ้าผู้ใช้กด "อนุญาตตลอดแชทนี้"/"อนุญาตเสมอ" — ไม่มี = เลือกได้แค่ครั้งนี้ */
  suggestedRule?: Pick<PermissionRule, 'tool' | 'pattern'>;
  /** ตำแหน่งใน ChatMessage.content ตอนที่ tool นี้เริ่ม — ใช้วาง tool card แทรกระหว่างข้อความตามลำดับจริง */
  contentOffset?: number;
  /** ตำแหน่งใน ChatMessage.thought ตอนที่ tool นี้เริ่ม — แบ่งความคิดตาม step */
  thoughtOffset?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thought?: string;
  toolCalls?: ToolCallRecord[];
  timestamp: number;
  modelUsed?: string;
  providerUsed?: string;
  tokenUsage?: TokenUsage;
  durationMs?: number;
  isError?: boolean;
  /** ไฟล์ที่ agent แก้ในเทิร์นนี้ (เนื้อหาเดิมเก็บในหน่วยความจำ — undo ได้เฉพาะระหว่างที่แอปยังเปิดอยู่) */
  checkpoint?: TurnCheckpointInfo;
  /** รูปที่แนบมากับข้อความผู้ใช้ — `data` ไม่ถูกบันทึกลงเครื่อง (ใหญ่เกิน localStorage) */
  images?: ImageAttachment[];
}

export interface TurnCheckpointInfo {
  files: string[];
  /** ไฟล์ที่เก็บ checkpoint ไม่ได้ (ไฟล์ใหญ่/ไม่ใช่ข้อความ) */
  skipped?: string[];
  revertedAt?: number;
}

export interface ImageAttachment {
  id: string;
  name: string;
  /** image/png, image/jpeg, image/webp, image/gif */
  mediaType: string;
  /** base64 ไม่มี prefix `data:` */
  data?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  model?: string;
  provider?: AIProvider;
  sessionTokens?: number;
}

export interface FileItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

export interface AppSettings {
  provider: AIProvider;
  model: string;
  reasoningEffort: ReasoningEffort;
  language: 'th' | 'en';
  theme?: ThemePreference;
  autoPilot: boolean;
  cwd: string;
  apiKeys: Record<AIProvider, string>;
  permissionRules: PermissionRule[];
}

/** shell = คำสั่ง PowerShell, read = อ่าน/ค้นไฟล์, edit = เขียน/แก้ไฟล์ */
export type PermissionTool = 'shell' | 'read' | 'edit';
export const PERMISSION_TOOLS: PermissionTool[] = ['shell', 'read', 'edit'];

/**
 * กฎสิทธิ์ของผู้ใช้ — deny ชนะ allow เสมอ
 * pattern ใช้ `*` แทนอะไรก็ได้ (shell: เทียบทั้งคำสั่ง, ไฟล์: เทียบพาธใน workspace หรือชื่อไฟล์)
 */
export interface PermissionRule {
  id: string;
  action: 'allow' | 'deny';
  tool: PermissionTool;
  pattern: string;
}

/** เหตุผลที่ต้องขออนุมัติ — UI แปลเป็นข้อความตามภาษา */
export type ApprovalReason = 'sensitive_file' | 'shell_chaining' | 'shell_risky' | 'shell_command' | 'supervised';

/** ผลการกดอนุมัติ: ครั้งนี้ / ตลอดแชทนี้ / บันทึกเป็นกฎถาวร */
export type ApprovalDecision = 'reject' | 'once' | 'session' | 'always';

export interface ShellOutputEventPayload {
  /** ลำดับฝั่ง UI ใช้เป็น React key */
  seq?: number;
  id: string;
  stream: 'stdout' | 'stderr' | 'exit' | 'error';
  text: string;
  exit_code?: number;
}

/** โมเดลเริ่มต้นของ provider (ตัวที่มี isDefault ไม่ใช่ตัวแรกของลิสต์) */
export function defaultModelFor(provider: AIProvider): string {
  const info = PROVIDERS_CATALOG.find((p) => p.id === provider);
  return info?.models.find((m) => m.isDefault)?.id ?? info?.models[0]?.id ?? '';
}
