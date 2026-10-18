import type { AIProvider, AppSettings, PermissionRule } from '../../types/agent';
import { PROVIDERS_CATALOG } from '../../types/agent';
import { fromNeutral, pruneHistory, toNeutral } from './history';
import { newRuleId } from './permissions';
import { buildSystemPrompt } from './prompt';
import { runAnthropicTurn } from './providers/anthropic';
import { runGoogleTurn } from './providers/google';
import { runOpenAITurn } from './providers/openai';
import { compactToolResult, executeTool } from './tools';
import {
  AgentAbortError,
  type AgentCallbacks,
  type AgentResponseResult,
  type HistoryFormat,
  type NeutralMessage,
  type PermissionStore,
  type TurnContext,
  type TurnResult,
} from './types';

const MAX_HISTORY_MESSAGES = 60;

function formatFor(provider: AIProvider): HistoryFormat {
  if (provider === 'google') return 'google';
  if (provider === 'anthropic') return 'anthropic';
  return 'openai';
}

const DRIVERS: Record<HistoryFormat, (ctx: TurnContext, input: string) => Promise<TurnResult>> = {
  google: runGoogleTurn,
  anthropic: runAnthropicTurn,
  openai: runOpenAITurn,
};

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
  /** กฎจากปุ่ม "อนุญาตตลอดแชทนี้" — หายเมื่อเริ่มแชทใหม่หรือสลับแชท */
  private sessionRules: PermissionRule[] = [];

  constructor(settings: AppSettings) {
    this.settings = settings;
  }

  updateSettings(settings: AppSettings) {
    this.settings = settings;
  }

  clearHistory() {
    this.history = [];
    this.historyFormat = null;
    this.pendingNeutral = [];
    this.sessionRules = [];
  }

  /** โหลดประวัติจาก session ที่บันทึกไว้ (text-only) */
  setHistory(messages: { role: string; content: string }[]) {
    this.clearHistory();
    this.pendingNeutral = (messages || [])
      .filter((m) => m?.content && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role as NeutralMessage['role'], text: m.content }));
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

  async sendMessage(
    userInput: string,
    callbacks: AgentCallbacks,
    signal?: AbortSignal
  ): Promise<AgentResponseResult> {
    const settings = this.settings;
    const provider = settings.provider;
    const apiKey = settings.apiKeys[provider]?.trim() || '';
    if (!apiKey) {
      const name = PROVIDERS_CATALOG.find((p) => p.id === provider)?.name || provider;
      throw new Error(
        settings.language === 'en'
          ? `Add an API key for ${name} in Settings first.`
          : `กรุณาใส่ API Key ของ ${name} ในหน้าตั้งค่าก่อนใช้งาน`
      );
    }

    const format = formatFor(provider);
    this.history = pruneHistory(this.historyFor(format), format, MAX_HISTORY_MESSAGES);
    const snapshotLength = this.history.length;
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
      systemPrompt: buildSystemPrompt(settings),
      runTool: async (name, args) => compactToolResult(await executeTool(name, args, settings, trackedCallbacks, permissions)),
    };

    try {
      const result = await DRIVERS[format](ctx, userInput);
      return { text: result.text, tokenUsage: result.usage, durationMs: Date.now() - startTime };
    } catch (err) {
      // ย้อนประวัติให้สะอาด แล้วจำสิ่งที่ผู้ใช้ถามและที่ตอบไปแล้วแบบ text-only
      this.history.length = snapshotLength;
      const recovered: NeutralMessage[] = [{ role: 'user', text: userInput }];
      // ใส่ assistant เสมอ เพื่อให้ role สลับกัน (Gemini ไม่รับ user ติดกัน)
      recovered.push({ role: 'assistant', text: partialText.trim() ? partialText : '(interrupted before answering)' });
      this.history.push(...fromNeutral(recovered, format));

      const aborted = signal?.aborted || (err as any)?.name === 'AbortError' || err instanceof AgentAbortError;
      throw aborted ? new AgentAbortError() : err;
    }
  }
}
