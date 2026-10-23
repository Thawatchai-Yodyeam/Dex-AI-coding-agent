import { findModel, type AppSettings, type TokenUsage } from '../../types/agent';
import { CONTEXT_BUDGET_CHARS, cutAt, estimateHistoryChars, fromNeutral, isUserTextTurn } from './history';
import type { HistoryFormat, TurnContext, TurnResult, UserInput } from './types';

/**
 * ประวัติเกินเท่านี้ตอนเริ่มเทิร์น → ให้โมเดลสรุปเทิร์นเก่าแทนการทิ้ง
 * ต่ำกว่างบที่ trimToolResults เริ่มล้างผล tool (100%) จะได้สรุปตอนที่รายละเอียดยังอยู่ครบ
 */
export const COMPACT_AT_CHARS = Math.floor(CONTEXT_BUDGET_CHARS * 0.8);
/** เก็บเทิร์นล่าสุดไว้ทั้งเทิร์น (รวม tool call/result) — งานที่กำลังทำต่อเนื่องต้องเห็นของจริง */
const KEEP_RECENT_TURNS = 2;
/** ส่วนที่เก็บไว้ใหญ่เกินนี้ → เก็บแค่เทิร์นล่าสุด */
const MAX_KEPT_CHARS = Math.floor(CONTEXT_BUDGET_CHARS * 0.4);

/** transcript ที่ส่งให้โมเดลสรุป (~60k token) — ตัดแต่ละรายการให้สั้น ผลของ tool มักยาวแต่สำคัญน้อย */
const MAX_TRANSCRIPT_CHARS = 240_000;
const MAX_TEXT_CHARS = 6_000;
const MAX_TOOL_ARGS_CHARS = 400;
const MAX_TOOL_RESULT_CHARS = 1_500;

const SUMMARY_SYSTEM_PROMPT = `You compress the earlier part of a conversation between a user and Dex, an AI coding agent working in a local workspace, so the work can continue in a fresh context window without the original messages.

Write a summary that covers:
- What the user wants: goals, requests, preferences and constraints they stated (quote their wording when it matters)
- Decisions made and the reasons
- Files read, created or changed (relative paths) and what changed in them
- Commands that matter (builds, tests, installs) and their outcome; errors that are still unresolved
- Work still open and the next step that was planned

Be specific: keep names, paths, values and error messages. Leave out pleasantries and anything that was later superseded. Use short bullet points under headings. Write in English, but keep the user's quotes, identifiers and paths as they are. Do not call tools.`;

const SUMMARY_NOTE =
  '[Summary of the earlier conversation, written by Dex when the context got long. Treat it as background — files may have changed since, so re-read them before editing.]';
const SUMMARY_ACK = 'Understood. I will continue from this summary.';

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)} … [${text.length - max} more chars]`;

/** เนื้อหาที่เป็นได้ทั้ง string, content blocks/parts หรือ object → ข้อความ */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b?.text === 'string' ? b.text : b?.type === 'image' || b?.type === 'image_url' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** ประวัติ native → บรรทัดอ่านง่ายของทุกค่าย (ทิ้ง thinking, ย่อ tool call/result) */
export function historyToTranscript(history: any[], format: HistoryFormat): string[] {
  const lines: string[] = [];
  const say = (who: 'User' | 'Assistant', text: string) => {
    if (text.trim()) lines.push(`${who}: ${clip(text.trim(), MAX_TEXT_CHARS)}`);
  };
  const call = (name: unknown, args: unknown) => {
    const json = typeof args === 'string' ? args : JSON.stringify(args ?? {});
    lines.push(`Assistant called ${String(name)}(${clip(json, MAX_TOOL_ARGS_CHARS)})`);
  };
  const result = (content: unknown) => lines.push(`Tool result: ${clip(textOf(content).trim(), MAX_TOOL_RESULT_CHARS)}`);

  for (const m of history) {
    if (!m) continue;
    if (format === 'openai') {
      if (m.role === 'tool') result(m.content);
      else if (m.role === 'user') say('User', textOf(m.content));
      else if (m.role === 'assistant') {
        say('Assistant', textOf(m.content));
        for (const tc of m.tool_calls ?? []) call(tc?.function?.name, parseArgs(tc?.function?.arguments));
      }
    } else if (format === 'anthropic') {
      const who = m.role === 'assistant' ? 'Assistant' : 'User';
      if (typeof m.content === 'string') {
        say(who, m.content);
        continue;
      }
      for (const b of m.content ?? []) {
        if (b?.type === 'text') say(who, b.text ?? '');
        else if (b?.type === 'tool_use') call(b.name, b.input);
        else if (b?.type === 'tool_result') result(b.content);
        else if (b?.type === 'image') say(who, '[image]');
      }
    } else {
      const who = m.role === 'model' ? 'Assistant' : 'User';
      for (const p of m.parts ?? []) {
        if (p?.thought) continue;
        if (typeof p?.text === 'string') say(who, p.text);
        else if (p?.functionCall) call(p.functionCall.name, p.functionCall.args);
        else if (p?.functionResponse) result(p.functionResponse.response?.result ?? p.functionResponse.response);
        else if (p?.inlineData) say(who, '[image]');
      }
    }
  }
  return lines;
}

/** ยาวเกิน → เก็บบรรทัดแรก (อาจเป็นสรุปรอบก่อน) และบรรทัดท้าย ๆ เท่าที่พอ */
export function fitTranscript(lines: string[], max = MAX_TRANSCRIPT_CHARS): string {
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total <= max || lines.length < 2) return lines.join('\n');
  const [first, ...rest] = lines;
  let room = max - first.length - 100;
  let start = rest.length;
  while (start > 0 && room - rest[start - 1].length - 1 >= 0) {
    start--;
    room -= rest[start].length + 1;
  }
  return [first, `[… ${start} earlier items omitted …]`, ...rest.slice(start)].join('\n');
}

/** ทุกอย่างก่อน index นี้ถูกสรุป (ตัดที่ขอบเทิร์นเสมอ) — null = ไม่มีเทิร์นเก่าให้สรุป */
export function compactionCut(history: any[], format: HistoryFormat): number | null {
  const starts = history.flatMap((m, i) => (i > 0 && isUserTextTurn(m, format) ? [i] : []));
  if (starts.length === 0) return null;
  const keepSeveral = starts[starts.length - KEEP_RECENT_TURNS];
  if (keepSeveral !== undefined && estimateHistoryChars(history.slice(keepSeveral)) <= MAX_KEPT_CHARS) return keepSeveral;
  return starts[starts.length - 1];
}

export interface CompactionResult {
  history: any[];
  usage: TokenUsage;
}

/**
 * แทนเทิร์นเก่าด้วยสรุปที่โมเดลเขียน: [user: สรุป, assistant: รับทราบ] + เทิร์นล่าสุดแบบเต็ม
 * ใช้ driver ของค่ายเดียวกัน (ได้ auth/retry ครบ) แบบไม่มี tool และใช้ระดับการคิดต่ำสุดของโมเดล
 * คืน null ถ้าไม่มีอะไรให้สรุป — error (รวมผู้ใช้กดหยุด) ถูกโยนต่อให้ผู้เรียกตัดสินใจ
 */
export async function compactHistory(
  history: any[],
  format: HistoryFormat,
  run: (ctx: TurnContext, input: UserInput) => Promise<TurnResult>,
  options: { settings: AppSettings; apiKey: string; signal?: AbortSignal; onRetry?: TurnContext['callbacks']['onRetry'] }
): Promise<CompactionResult | null> {
  const cut = compactionCut(history, format);
  if (cut === null) return null;
  const { settings } = options;
  const lowestEffort = findModel(settings.provider, settings.model)?.efforts[0];
  const transcript = fitTranscript(historyToTranscript(history.slice(0, cut), format));
  const res = await run(
    {
      settings: lowestEffort ? { ...settings, reasoningEffort: lowestEffort } : settings,
      apiKey: options.apiKey,
      history: [],
      tools: [],
      callbacks: {
        onTextChunk: () => {},
        onToolStart: () => {},
        onToolUpdate: () => {},
        onRequestApproval: async () => 'reject',
        onRetry: options.onRetry,
      },
      signal: options.signal,
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      runTool: async () => ({ error: 'Tools are not available while summarizing.' }),
    },
    { text: `<transcript>\n${transcript}\n</transcript>\n\nSummarize the transcript above as instructed.` }
  );
  const summary = res.text.trim();
  if (!summary) throw new Error('The model returned an empty summary');
  const head = fromNeutral(
    [
      { role: 'user', text: `${SUMMARY_NOTE}\n<conversation_summary>\n${summary}\n</conversation_summary>` },
      { role: 'assistant', text: SUMMARY_ACK },
    ],
    format
  );
  return { history: [...head, ...cutAt(history, format, cut)], usage: res.usage };
}
