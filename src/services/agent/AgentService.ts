import type { AIProvider, AppSettings, PermissionRule, TokenUsage, ToolCallRecord } from '../../types/agent';
import { PROVIDERS_CATALOG, requiresApiKey, supportsImages } from '../../types/agent';
import { tauriBridge } from '../tauriBridge';
import { COMPACT_AT_CHARS, compactHistory, type CompactionResult } from './compaction';
import { estimateHistoryChars, fromNeutral, isUserTextTurn, pruneHistory, pruneHistoryToBudget, stripThinking, toNeutral } from './history';
import { newRuleId } from './permissions';
import {
  MAX_PROJECT_INSTRUCTION_CHARS,
  PROJECT_INSTRUCTION_FILES,
  buildSystemPrompt,
  type ProjectInstructions,
} from './prompt';
import { runAnthropicTurn } from './providers/anthropic';
import { runGoogleTurn } from './providers/google';
import { runOpenAITurn } from './providers/openai';
import { withToolLimitErrors } from './providers/toolLimits';
import { loadSkills, USE_SKILL_TOOL } from './skills';
import {
  TOOL_DEFINITIONS,
  compactToolResult,
  executeTool,
  resolveWorkspacePath,
  type McpToolRunner,
  type ToolContext,
} from './tools';
import type { SkillInfo } from '../tauriBridge';
import {
  AgentAbortError,
  addUsage,
  imagesWithData,
  throwIfAborted,
  type AgentCallbacks,
  type AgentResponseResult,
  type HistoryFormat,
  type NeutralMessage,
  type PermissionStore,
  type ToolDefinition,
  type TurnContext,
  type TurnResult,
  type UserInput,
} from './types';

/** เพดานจำนวนข้อความกันประวัติโตไม่จำกัด — ตัวคุมหลักคือขนาด (pruneHistoryToBudget / trimToolResults) */
const MAX_HISTORY_MESSAGES = 400;

function formatFor(provider: AIProvider): HistoryFormat {
  if (provider === 'google') return 'google';
  if (provider === 'anthropic') return 'anthropic';
  return 'openai';
}

/** สิ่งที่ AgentService ต้องการจาก MCP manager */
export interface McpProvider extends McpToolRunner {
  /** tool ของทุก server ที่เชื่อมต่ออยู่ ยกเว้นตัวที่ผู้ใช้ปิด ชื่อขึ้นต้นด้วย mcp__<server>__ */
  toolDefinitions(): ToolDefinition[];
}

/** เทิร์นเดียววนเกินกี่ step แล้วถามผู้ใช้ว่าจะให้ทำต่อไหม (กันวนเผา token ไม่จบ) */
export const STEPS_PER_CONFIRM = 50;

interface HistorySnapshot {
  v: 1;
  format: HistoryFormat;
  history: any[];
  sessionRules?: PermissionRule[];
  /** ชุด tool ที่ thinking block ใน history ผูกอยู่ — snapshot รุ่นเก่าไม่มี */
  toolSetId?: string;
}

const DRIVERS: Record<HistoryFormat, (ctx: TurnContext, input: UserInput) => Promise<TurnResult>> = {
  google: withToolLimitErrors(runGoogleTurn),
  anthropic: withToolLimitErrors(runAnthropicTurn),
  openai: withToolLimitErrors(runOpenAITurn),
};

/** รหัสของชุด tool (FNV-1a) ไว้เทียบว่าเปลี่ยนไหม — เก็บลงไฟล์ประวัติได้โดยไม่ต้องเก็บ schema ทั้งก้อน */
function toolSetIdOf(tools: readonly ToolDefinition[]): string {
  const json = JSON.stringify(tools);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) hash = Math.imul(hash ^ json.charCodeAt(i), 0x01000193);
  return `${json.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

/**
 * ทุก STEPS_PER_CONFIRM step ถามผู้ใช้ผ่านแถบอนุมัติแบบเดียวกับ tool (การ์ด "ทำงานต่อ")
 * คืน false = ผู้ใช้ให้หยุด driver จะปิดเทิร์นอย่างเรียบร้อย (ประวัติยังใช้ต่อได้)
 */
async function confirmContinue(step: number, callbacks: AgentCallbacks): Promise<boolean> {
  if (step === 0 || step % STEPS_PER_CONFIRM !== 0) return true;
  const record: ToolCallRecord = {
    id: `continue-${Date.now()}-${step}`,
    name: 'continue_turn',
    args: { steps: step },
    status: 'pending_approval',
    approvalReason: 'step_limit',
  };
  callbacks.onToolStart({ ...record });
  const decision = await callbacks.onRequestApproval({ ...record });
  record.approvalReason = undefined;
  record.status = decision === 'reject' ? 'rejected' : 'completed';
  callbacks.onToolUpdate({ ...record });
  return decision !== 'reject';
}

/**
 * ตัวกลางระหว่าง UI กับ provider driver
 * - เก็บประวัติในรูปแบบ native ของ provider ที่ใช้อยู่ และแปลงให้เมื่อสลับ provider
 * - ถ้าเทิร์นล้มเหลว/ถูกยกเลิก จะย้อนประวัติกลับ แล้วเก็บไว้เพียงข้อความผู้ใช้ + ข้อความที่ได้มาแล้ว
 *   (กันไม่ให้มี tool_call ค้างไม่มีคู่ ซึ่งทำให้เทิร์นถัดไปตอบ 400)
 */
export class MultiProviderAgentService {
  private settings: AppSettings;
  private history: any[] = [];
  private historyFormat: HistoryFormat | null = null;
  private pendingNeutral: NeutralMessage[] = [];
  /** กฎจากปุ่ม "อนุญาตตลอดแชทนี้" — บันทึกไปกับประวัติของแชทนั้น */
  private sessionRules: PermissionRule[] = [];
  /** เพิ่มทุกครั้งที่ประวัติถูกแทนที่หรือเริ่มเทิร์นใหม่ — กันประวัติที่โหลดจากไฟล์มาช้าเขียนทับของใหม่ */
  private version = 0;
  private turnVersion = -1;
  private mcp: McpProvider | null = null;
  private toolSetId: string | undefined;

  constructor(settings: AppSettings) {
    this.settings = settings;
  }

  updateSettings(settings: AppSettings) {
    this.settings = settings;
  }

  get historyVersion(): number {
    return this.version;
  }

  /** version ตอนเริ่มเทิร์นล่าสุด — เท่ากับ historyVersion = ประวัติยังเป็นของเทิร์นนั้น (ไม่ถูกสลับ/ล้าง) */
  get lastTurnVersion(): number {
    return this.turnVersion;
  }

  clearHistory() {
    this.history = [];
    this.historyFormat = null;
    this.pendingNeutral = [];
    this.sessionRules = [];
    this.toolSetId = undefined;
    this.version++;
  }

  /** โหลดประวัติจาก session ที่บันทึกไว้ (text-only) */
  setHistory(messages: { role: string; content: string }[]) {
    this.clearHistory();
    this.pendingNeutral = (messages || [])
      .filter((m) => m?.content && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role as NeutralMessage['role'], text: m.content }));
  }

  /** ประวัติแบบ native (รวม tool call/result) ไว้บันทึกลงไฟล์ — null = ยังไม่มีอะไรให้บันทึก */
  exportHistory(): string | null {
    if (this.historyFormat === null || this.history.length === 0) return null;
    const snapshot: HistorySnapshot = {
      v: 1,
      format: this.historyFormat,
      history: this.history,
      sessionRules: this.sessionRules,
      toolSetId: this.toolSetId,
    };
    return JSON.stringify(snapshot);
  }

  /**
   * แทนประวัติ text-only ด้วยประวัติ native ที่บันทึกไว้ — ใช้ได้เฉพาะเมื่อยังไม่มีอะไรเปลี่ยนตั้งแต่
   * `expectedVersion` (ผู้ใช้อาจส่งข้อความไปก่อนที่ไฟล์จะโหลดเสร็จ) คืน true ถ้าใช้ได้
   */
  restoreHistory(json: string, expectedVersion: number): boolean {
    if (this.version !== expectedVersion) return false;
    let snapshot: HistorySnapshot;
    try {
      snapshot = JSON.parse(json);
    } catch {
      return false;
    }
    if (snapshot?.v !== 1 || !Array.isArray(snapshot.history) || !['google', 'anthropic', 'openai'].includes(snapshot.format)) {
      return false;
    }
    this.history = snapshot.history;
    this.historyFormat = snapshot.format;
    this.pendingNeutral = [];
    this.sessionRules = Array.isArray(snapshot.sessionRules) ? snapshot.sessionRules : [];
    this.toolSetId = typeof snapshot.toolSetId === 'string' ? snapshot.toolSetId : undefined;
    this.version++;
    return true;
  }

  private historyFor(format: HistoryFormat): any[] {
    if (this.historyFormat === format) return this.history;
    const neutral =
      this.historyFormat === null ? this.pendingNeutral : toNeutral(this.history, this.historyFormat);
    this.pendingNeutral = [];
    this.historyFormat = format;
    this.history = fromNeutral(neutral, format);
    return this.history;
  }

  /**
   * ย้อนประวัติ native ไปก่อนข้อความผู้ใช้ที่ `turnsFromEnd` นับจากท้าย (1 = ข้อความล่าสุด) — ใช้กับ
   * regenerate / แก้ข้อความแล้วส่งใหม่ จะเก็บ tool call/result ของเทิร์นก่อนหน้าไว้ครบ
   * นับจากท้ายเพราะหัวประวัติอาจถูกตัดไปแล้ว และเทียบข้อความเพื่อยืนยันว่าตรงเทิร์นจริง
   * คืน false ถ้าหาไม่เจอหรือไม่ตรง — ผู้เรียกควร fallback เป็น setHistory แบบ text-only
   */
  rewindBeforeUserTurn(userText: string, turnsFromEnd: number): boolean {
    const format = this.historyFormat;
    if (format === null || turnsFromEnd < 1) return false;
    const starts = this.history.flatMap((m, i) => (isUserTextTurn(m, format) ? [i] : []));
    const idx = starts[starts.length - turnsFromEnd];
    if (idx === undefined) return false;
    const text = toNeutral([this.history[idx]], format)[0]?.text ?? '';
    // ข้อความใน native อาจมีโน้ตจากแอปนำหน้า (เช่น แจ้งว่าย้อนไฟล์) จึงเทียบแบบ "ลงท้ายด้วย"
    if (!text.trimEnd().endsWith(userText.trim())) return false;
    this.history = this.history.slice(0, idx);
    this.version++;
    return true;
  }

  /** skill ที่ใช้ได้ใน workspace นี้ (อ่านใหม่ทุกครั้ง — เพิ่ม/แก้ skill แล้วมีผลเทิร์นถัดไป) ตัดตัวที่ผู้ใช้ปิดไว้ */
  async listSkills(): Promise<SkillInfo[]> {
    const disabled = new Set((this.settings.disabledSkills ?? []).map((s) => s.toLowerCase()));
    return (await loadSkills(this.settings.cwd)).filter((s) => !disabled.has(s.name.toLowerCase()));
  }

  /** MCP manager ต่อ tool ของ server เข้ามาให้ทุกเทิร์น (null = ไม่มี) */
  setMcpProvider(provider: McpProvider | null) {
    this.mcp = provider;
  }

  /**
   * ประวัติใกล้เต็ม → ให้โมเดลสรุปเทิร์นเก่าแทนการทิ้ง (แทนที่ this.history เมื่อสำเร็จ)
   * สรุปไม่ได้ก็ทำเทิร์นต่อได้ เพราะ pruneHistoryToBudget จะล้าง/ตัดแบบเดิมให้ — ยกเว้นผู้ใช้กดหยุด
   */
  private async compactIfNeeded(
    format: HistoryFormat,
    apiKey: string,
    callbacks: AgentCallbacks,
    turnVersion: number,
    signal?: AbortSignal
  ): Promise<TokenUsage | null> {
    if (estimateHistoryChars(this.history) <= COMPACT_AT_CHARS) return null;
    const before = this.history;
    callbacks.onCompaction?.('start');
    let res: CompactionResult | null = null;
    try {
      res = await compactHistory(before, format, DRIVERS[format], {
        settings: this.settings,
        apiKey,
        signal,
        onRetry: callbacks.onRetry,
      });
    } catch (err) {
      if (signal?.aborted) throw new AgentAbortError();
      console.warn('Context compaction failed, trimming instead:', err);
    }
    // ผู้ใช้สลับ/ล้างแชทระหว่างรอสรุป — ประวัตินี้ไม่ใช่ของเทิร์นนี้แล้ว
    if (this.version !== turnVersion || this.history !== before) throw new AgentAbortError();
    if (!res) {
      callbacks.onCompaction?.('skipped');
      return null;
    }
    this.history = res.history;
    callbacks.onCompaction?.('done');
    return res.usage;
  }

  /** อ่าน DEX.md / AGENTS.md / CLAUDE.md จากราก workspace (ไม่มี = null) — อ่านใหม่ทุกเทิร์นเพื่อให้แก้แล้วมีผลทันที */
  async loadProjectInstructions(): Promise<ProjectInstructions | null> {
    const cwd = this.settings.cwd;
    if (!cwd) return null;
    for (const file of PROJECT_INSTRUCTION_FILES) {
      try {
        const content = await tauriBridge.readFile(resolveWorkspacePath(cwd, file), cwd);
        if (!content.trim()) continue;
        const clipped =
          content.length > MAX_PROJECT_INSTRUCTION_CHARS
            ? `${content.slice(0, MAX_PROJECT_INSTRUCTION_CHARS)}\n\n[... truncated ...]`
            : content;
        return { file, content: clipped };
      } catch {
        // ไม่มีไฟล์นี้ — ลองชื่อถัดไป
      }
    }
    return null;
  }

  async sendMessage(
    input: UserInput,
    callbacks: AgentCallbacks,
    signal?: AbortSignal
  ): Promise<AgentResponseResult> {
    const userInput = input.text;
    const settings = this.settings;
    const provider = settings.provider;
    const apiKey = settings.apiKeys[provider]?.trim() || '';
    if (!apiKey && requiresApiKey(provider)) {
      const name = PROVIDERS_CATALOG.find((p) => p.id === provider)?.name || provider;
      throw new Error(
        settings.language === 'en'
          ? `Add an API key for ${name} in Settings first.`
          : `กรุณาใส่ API Key ของ ${name} ในหน้าตั้งค่าก่อนใช้งาน`
      );
    }

    if (imagesWithData(input).length > 0 && !supportsImages(provider)) {
      const name = PROVIDERS_CATALOG.find((p) => p.id === provider)?.name || provider;
      throw new Error(
        settings.language === 'en'
          ? `${name} does not accept images. Switch to another model or remove the images.`
          : `${name} ยังรับรูปภาพไม่ได้ — เปลี่ยนโมเดลหรือเอารูปออกก่อน`
      );
    }

    // อ่านก่อนแตะ history — ถ้าอ่านพลาดก็แค่ไม่มีคำสั่งประจำโปรเจกต์/skill
    const [project, skills] = await Promise.all([this.loadProjectInstructions(), this.listSkills()]);
    throwIfAborted(signal);
    const mcp = this.mcp;
    const tools: ToolDefinition[] = [
      ...TOOL_DEFINITIONS,
      ...(skills.length > 0 ? [USE_SKILL_TOOL] : []),
      ...(mcp?.toolDefinitions() ?? []),
    ];
    const toolContext: ToolContext = { skills, signal, ...(mcp ? { mcp } : {}) };

    const format = formatFor(provider);
    const turnVersion = ++this.version;
    this.turnVersion = turnVersion;
    this.history = pruneHistory(this.historyFor(format), format, MAX_HISTORY_MESSAGES);
    // Claude 5.1 ขึ้นไปผูก thinking block กับชุด tool ตอนที่สร้าง: เปิด/ปิด tool หรือ server กลางแชทแล้วส่ง block เดิมไป
    // API จะตอบ 400 ทุกคำขอ จึงถอดออกก่อน (โมเดลเสียแค่เหตุผลเก่า ส่วนข้อความกับผลของ tool ยังอยู่ครบ)
    const toolSetId = toolSetIdOf(tools);
    if (format === 'anthropic' && this.toolSetId !== toolSetId) this.history = stripThinking(this.history);
    this.toolSetId = toolSetId;
    // ถูกแทนหลังสรุปบทสนทนา (ถ้ามี) — catch ใช้ย้อนประวัติของเทิร์นนี้
    let turnHistory = this.history;
    let snapshotLength = turnHistory.length;
    const startTime = Date.now();

    let partialText = '';
    const trackedCallbacks: AgentCallbacks = {
      ...callbacks,
      onTextChunk: (chunk, full) => {
        partialText = full;
        callbacks.onTextChunk(chunk, full);
      },
    };

    // อ่าน settings ล่าสุดทุกครั้ง — กฎที่ผู้ใช้เพิ่งกด "อนุญาตเสมอ" ต้องมีผลกับ tool ถัดไปในเทิร์นเดียวกัน
    const permissions: PermissionStore = {
      rules: () => [...(this.settings.permissionRules ?? []), ...this.sessionRules],
      addRule: (rule, scope) => {
        const full: PermissionRule = { id: newRuleId(), action: 'allow', ...rule };
        this.sessionRules.push(full);
        if (scope === 'always') callbacks.onAddPermissionRule?.(full);
      },
    };

    const ctx: TurnContext = {
      settings,
      apiKey,
      history: this.history,
      callbacks: trackedCallbacks,
      signal,
      systemPrompt: buildSystemPrompt(settings, project, skills),
      tools,
      // โหมดวางแผนอ่านค่าล่าสุดทุกครั้ง — ผู้ใช้เปิดกลางเทิร์นแล้ว tool ถัดไปต้องหยุดแก้ไฟล์ทันที
      runTool: async (name, args) =>
        compactToolResult(
          await executeTool(name, args, { ...settings, planMode: this.settings.planMode }, trackedCallbacks, permissions, toolContext),
          name
        ),
      shouldContinue: (step) => confirmContinue(step, trackedCallbacks),
    };

    try {
      const compactionUsage = await this.compactIfNeeded(format, apiKey, trackedCallbacks, turnVersion, signal);
      this.history = pruneHistoryToBudget(this.history, format);
      turnHistory = ctx.history = this.history;
      snapshotLength = turnHistory.length;

      const result = await DRIVERS[format](ctx, input);
      if (compactionUsage) addUsage(result.usage, compactionUsage);
      return { text: result.text, tokenUsage: result.usage, durationMs: Date.now() - startTime };
    } catch (err) {
      // ย้อนประวัติให้สะอาด แล้วจำสิ่งที่ผู้ใช้ถามและที่ตอบไปแล้วแบบ text-only
      // — เฉพาะเมื่อประวัติยังเป็นของเทิร์นนี้ (ผู้ใช้อาจสลับ/ล้างแชทระหว่างทาง ซึ่งแทนที่ประวัติไปแล้ว)
      if (this.version === turnVersion && this.history === turnHistory) {
        turnHistory.length = snapshotLength;
        const recovered: NeutralMessage[] = [{ role: 'user', text: userInput }];
        // ใส่ assistant เสมอ เพื่อให้ role สลับกัน (Gemini ไม่รับ user ติดกัน)
        recovered.push({ role: 'assistant', text: partialText.trim() ? partialText : '(interrupted before answering)' });
        turnHistory.push(...fromNeutral(recovered, format));
      }

      const aborted = signal?.aborted || (err as any)?.name === 'AbortError' || err instanceof AgentAbortError;
      throw aborted ? new AgentAbortError() : err;
    }
  }
}
