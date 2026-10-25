import { effectiveEffort } from '../../../types/agent';
import { dropOldToolImages, trimToolResults } from '../history';
import { TransientApiError, httpError, withRetry } from '../retry';
import { readSseData, tryParseJson } from '../sse';
import { isToolError, runToolCalls, toolResultToString } from '../tools';
import {
  addUsage,
  appendStepText,
  emptyUsage,
  imagesWithData,
  stepLimitNote,
  takeToolImages,
  throwIfAborted,
  type TurnContext,
  type TurnResult,
  type UserInput,
} from '../types';

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_TOKENS = 32_000;

/** รุ่นปัจจุบัน (4.6 ขึ้นไป / ตระกูล 5): ใช้ adaptive thinking + output_config.effort, budget_tokens จะได้ 400 */
function usesAdaptiveThinking(model: string): boolean {
  return /^claude-(fable|mythos|opus|sonnet|haiku)-5/.test(model) || /^claude-(opus|sonnet)-4-[6-9]/.test(model);
}

/** รุ่นที่รองรับ server-side refusal fallback แบบ `fallbacks: "default"` บน Claude API */
function supportsDefaultFallback(model: string): boolean {
  return /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/.test(model);
}

function buildThinkingParams(model: string, effort: string): Record<string, unknown> {
  if (usesAdaptiveThinking(model)) {
    if (effort === 'none') {
      // Haiku 5.5 ปิด thinking ได้ (ที่ effort ≤ high); Opus 5.5 / Sonnet 5.5 / Fable ปิดไม่ได้ (400) → ลด effort เหลือ low แทน
      return /^claude-haiku-5/.test(model)
        ? { thinking: { type: 'disabled' }, output_config: { effort: 'medium' } }
        : { output_config: { effort: 'low' } };
    }
    return {
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort },
    };
  }
  // รุ่นเก่า (Haiku 4.5, Sonnet 4.5 ...) ยังใช้ budget_tokens
  if (effort === 'none') return {};
  const budget = effort === 'low' ? 2048 : effort === 'high' ? 16384 : 8192;
  return { thinking: { type: 'enabled', budget_tokens: budget } };
}

const EPHEMERAL = { type: 'ephemeral' } as const;

/** สำเนาข้อความที่มี cache_control ที่ block สุดท้าย (thinking block ใส่ไม่ได้ จึงข้าม) */
function withCacheControl(message: any): any {
  if (typeof message.content === 'string') {
    return message.content ? { ...message, content: [{ type: 'text', text: message.content, cache_control: EPHEMERAL }] } : message;
  }
  if (!Array.isArray(message.content)) return message;
  const content = [...message.content];
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i]?.type !== 'thinking' && content[i]?.type !== 'redacted_thinking') {
      content[i] = { ...content[i], cache_control: EPHEMERAL };
      return { ...message, content };
    }
  }
  return message;
}

/**
 * Prompt caching: tool loop ส่งประวัติทั้งก้อนซ้ำทุก step — ใส่ breakpoint ที่ข้อความ user ล่าสุด
 * และ user ก่อนหน้า (เผื่อ step ใหม่ยาวเกินช่วงที่ API มองย้อนหา cache เดิม) ส่วน tools + system
 * มี breakpoint ของตัวเองใน body รวมเป็น 3 จากที่ API ให้ 4
 * คืนสำเนา — ถ้าเขียนลง history จริง breakpoint จะสะสมจนเกินเพดาน
 */
export function withCacheBreakpoints(history: any[]): any[] {
  const marks = new Set<number>();
  for (let i = history.length - 1; i >= 0 && marks.size < 2; i--) {
    if (history[i]?.role === 'user') marks.add(i);
  }
  return history.map((m, i) => (marks.has(i) ? withCacheControl(m) : m));
}

/** content block ระหว่างสตรีม — เก็บ field ดิบไว้ทั้งหมดเพื่อส่งคืน API แบบไม่แก้ไข */
type StreamBlock = Record<string, any> & { type: string; _json?: string };

/** ข้อความผู้ใช้: string ล้วนถ้าไม่มีรูป (ประวัติเดิมเป็นแบบนี้) ไม่งั้นเป็น image block ตามด้วย text */
export function anthropicUserContent(input: UserInput): string | any[] {
  const images = imagesWithData(input);
  if (images.length === 0) return input.text;
  const blocks: any[] = images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.data },
  }));
  // Anthropic ไม่รับ text block ว่าง
  if (input.text.trim()) blocks.push({ type: 'text', text: input.text });
  return blocks;
}

/** ผลของ tool → tool_result block (รูปจาก tool อยู่ใน content ได้เลย) */
export function anthropicToolResult(toolUseId: string, raw: unknown): any {
  const { result, images } = takeToolImages(raw);
  const text = toolResultToString(result);
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: images.length
      ? [
          { type: 'text', text },
          ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
        ]
      : text,
    ...(isToolError(result) ? { is_error: true } : {}),
  };
}

export async function runAnthropicTurn(ctx: TurnContext, input: UserInput): Promise<TurnResult> {
  const { settings, callbacks, signal, history } = ctx;
  const model = settings.model || DEFAULT_MODEL;

  const tools = ctx.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
    // สตรีม tool input ทันที (เนื้อหาไฟล์ยาวไม่ต้องรอ buffer) — input อาจไม่ครบ จึงต้อง validate เอง
    eager_input_streaming: true,
  }));

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': ctx.apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const useFallback = supportsDefaultFallback(model);
  if (useFallback) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';

  history.push({ role: 'user', content: anthropicUserContent(input) });

  let fullText = '';
  let fullThought = '';
  const usage = emptyUsage();

  // วนจนโมเดลตอบจบเอง — ผู้ใช้หยุดได้ด้วยปุ่ม Stop (abort signal) และถูกถามทุก STEPS_PER_CONFIRM step
  for (let step = 0; ; step++) {
    throwIfAborted(signal);
    if (ctx.shouldContinue && !(await ctx.shouldContinue(step))) {
      const note = stepLimitNote(settings.language, step);
      // ปิดเทิร์นด้วยข้อความ assistant ให้ลำดับ role ถูกต้องสำหรับเทิร์นถัดไป
      history.push({ role: 'assistant', content: [{ type: 'text', text: note }] });
      return { text: appendStepText(fullText, note, false), usage };
    }
    // tool loop ยาว ๆ (อ่านไฟล์หลายสิบไฟล์) ทำให้ประวัติโตเกิน context ได้ภายในเทิร์นเดียว
    trimToolResults(history, 'anthropic');
    dropOldToolImages(history, 'anthropic');

    const body: Record<string, unknown> = {
      model,
      max_tokens: MAX_TOKENS,
      // breakpoint ที่ system ครอบ tools ด้วย (ลำดับ prefix ของ cache คือ tools → system → messages)
      system: [{ type: 'text', text: ctx.systemPrompt, cache_control: EPHEMERAL }],
      messages: withCacheBreakpoints(history),
      ...(tools.length > 0 ? { tools } : {}),
      stream: true,
      ...buildThinkingParams(model, effectiveEffort(settings)),
    };
    if (useFallback) body.fallbacks = 'default';

    // หนึ่ง step = request + อ่านสตรีมจนจบ ถ้าล้มชั่วคราว (529, เน็ตหลุดกลางสตรีม) จะลองใหม่ทั้ง step
    // และส่งข้อความของ step นี้ให้ UI ใหม่ตั้งแต่ต้น — tool ยังไม่ถูกรันจนกว่าสตรีมจะจบ จึงปลอดภัย
    const textBefore = fullText;
    const thoughtBefore = fullThought;
    const streamed = await withRetry(
      async (attempt) => {
        if (attempt > 0) {
          fullText = textBefore;
          fullThought = thoughtBefore;
          callbacks.onTextChunk('', fullText);
          callbacks.onThoughtChunk?.('', fullThought);
        }
        const response = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body), signal });
        if (!response.ok) throw await httpError('Anthropic Error', response);

        const blocks: StreamBlock[] = [];
        let stopReason: string | null = null;
        let input = 0;
        let cached = 0;
        let output = 0;
        let stepHasText = false;

        for await (const data of readSseData(response, signal)) {
          const ev = tryParseJson(data);
          if (!ev) continue;

          switch (ev.type) {
            case 'error': {
              const message = `Anthropic Error: ${ev.error?.message || JSON.stringify(ev.error)}`;
              // overloaded/api_error กลางสตรีม = ฝั่ง API ล้มชั่วคราว ลองใหม่ได้
              throw ['overloaded_error', 'api_error'].includes(ev.error?.type)
                ? new TransientApiError(message)
                : new Error(message);
            }
            case 'message_start': {
              const u = ev.message?.usage ?? {};
              cached = u.cache_read_input_tokens ?? 0;
              input = (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0);
              break;
            }
            case 'message_delta':
              if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
              if (typeof ev.usage?.output_tokens === 'number') output = ev.usage.output_tokens;
              break;
            case 'content_block_start': {
              const block: StreamBlock = { ...ev.content_block };
              if (block.type === 'tool_use') block._json = '';
              blocks[ev.index] = block;
              break;
            }
            case 'content_block_delta': {
              const block = blocks[ev.index];
              const d = ev.delta;
              if (!block || !d) break;
              if (d.type === 'text_delta') {
                block.text = (block.text ?? '') + d.text;
                fullText = appendStepText(fullText, d.text, stepHasText);
                stepHasText = true;
                callbacks.onTextChunk(d.text, fullText);
              } else if (d.type === 'thinking_delta') {
                block.thinking = (block.thinking ?? '') + d.thinking;
                fullThought += d.thinking;
                callbacks.onThoughtChunk?.(d.thinking, fullThought);
              } else if (d.type === 'signature_delta') {
                block.signature = d.signature;
              } else if (d.type === 'input_json_delta') {
                block._json = (block._json ?? '') + d.partial_json;
              }
              break;
            }
          }
        }
        return { blocks, stopReason, input, cached, output };
      },
      { signal, onRetry: callbacks.onRetry }
    );
    const { blocks, stopReason } = streamed;
    addUsage(usage, {
      promptTokens: streamed.input,
      completionTokens: streamed.output,
      totalTokens: 0,
      cachedTokens: streamed.cached,
    });

    // แปลง tool_use input จาก JSON ที่สตรีมมา; JSON เสีย (โดนตัดเพราะ max_tokens) → ทำเครื่องหมายไว้ไม่รัน
    const invalidToolIds = new Set<string>();
    const content = blocks.filter(Boolean).map((b) => {
      if (b.type !== 'tool_use') return b;
      const { _json, ...rest } = b;
      const parsed = tryParseJson(_json || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        invalidToolIds.add(rest.id);
        return { ...rest, input: {} };
      }
      return { ...rest, input: parsed };
    });

    // ส่ง content ทุก block กลับไปแบบไม่แก้ไข (thinking + signature จำเป็นต่อ tool loop)
    if (content.length > 0) history.push({ role: 'assistant', content });

    if (stopReason === 'refusal') {
      const note = settings.language === 'en'
        ? '\n\n*(The model declined this request.)*'
        : '\n\n*(โมเดลปฏิเสธคำขอนี้)*';
      return { text: fullText + note, usage };
    }

    const toolUses = content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0 || stopReason !== 'tool_use') {
      if (stopReason === 'max_tokens') {
        fullText += settings.language === 'en'
          ? '\n\n*(Response hit the output token limit.)*'
          : '\n\n*(คำตอบยาวเกินเพดาน token ของรอบนี้)*';
      }
      // ถ้ามี tool_use ค้าง (ถูกตัดกลางคัน) ต้องปิดคู่ด้วย tool_result ไม่งั้นเทิร์นหน้าจะ 400
      if (toolUses.length > 0) {
        history.push({
          role: 'user',
          content: toolUses.map((b) => ({
            type: 'tool_result',
            tool_use_id: b.id,
            content: 'Not executed: response was cut off before the tool call completed.',
            is_error: true,
          })),
        });
      }
      return { text: fullText, usage };
    }

    // ผลลัพธ์ทุก tool ต้องอยู่ใน user message เดียว
    const results = await runToolCalls(toolUses, (b) => b.name, async (b): Promise<any> => {
      if (invalidToolIds.has(b.id)) {
        return {
          type: 'tool_result',
          tool_use_id: b.id,
          content: 'INVALID_JSON: tool input was incomplete or malformed. Please retry the call.',
          is_error: true,
        };
      }
      return anthropicToolResult(b.id, await ctx.runTool(b.name, b.input));
    });
    history.push({ role: 'user', content: results });
  }
}
