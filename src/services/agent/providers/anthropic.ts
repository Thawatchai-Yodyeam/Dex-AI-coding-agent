import { effectiveEffort } from '../../../types/agent';
import { readSseData, tryParseJson } from '../sse';
import { TOOL_DEFINITIONS, isToolError, toolResultToString } from '../tools';
import {
  addUsage,
  appendStepText,
  emptyUsage,
  throwIfAborted,
  type TurnContext,
  type TurnResult,
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

/** content block ระหว่างสตรีม — เก็บ field ดิบไว้ทั้งหมดเพื่อส่งคืน API แบบไม่แก้ไข */
type StreamBlock = Record<string, any> & { type: string; _json?: string };

export async function runAnthropicTurn(ctx: TurnContext, userInput: string): Promise<TurnResult> {
  const { settings, callbacks, signal, history } = ctx;
  const model = settings.model || DEFAULT_MODEL;

  const tools = TOOL_DEFINITIONS.map((t) => ({
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

  history.push({ role: 'user', content: userInput });

  let fullText = '';
  let fullThought = '';
  const usage = emptyUsage();

  // ไม่จำกัดจำนวน step: วนจนโมเดลตอบจบเอง (ผู้ใช้หยุดได้ด้วยปุ่ม Stop → abort signal)
  for (;;) {
    throwIfAborted(signal);
    let stepHasText = false;

    const body: Record<string, unknown> = {
      model,
      max_tokens: MAX_TOKENS,
      system: ctx.systemPrompt,
      messages: history,
      tools,
      stream: true,
      ...buildThinkingParams(model, effectiveEffort(settings)),
    };
    if (useFallback) body.fallbacks = 'default';

    const response = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!response.ok) {
      throw new Error(`Anthropic Error [${response.status}]: ${await response.text()}`);
    }

    const blocks: StreamBlock[] = [];
    let stopReason: string | null = null;
    let stepInput = 0;
    let stepOutput = 0;

    for await (const data of readSseData(response, signal)) {
      const ev = tryParseJson(data);
      if (!ev) continue;

      switch (ev.type) {
        case 'error':
          throw new Error(`Anthropic Error: ${ev.error?.message || JSON.stringify(ev.error)}`);
        case 'message_start': {
          const u = ev.message?.usage ?? {};
          stepInput = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          break;
        }
        case 'message_delta':
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
          if (typeof ev.usage?.output_tokens === 'number') stepOutput = ev.usage.output_tokens;
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
    addUsage(usage, { promptTokens: stepInput, completionTokens: stepOutput, totalTokens: 0 });

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
    const results: any[] = [];
    for (const b of toolUses) {
      if (invalidToolIds.has(b.id)) {
        results.push({
          type: 'tool_result',
          tool_use_id: b.id,
          content: 'INVALID_JSON: tool input was incomplete or malformed. Please retry the call.',
          is_error: true,
        });
        continue;
      }
      const result = await ctx.runTool(b.name, b.input);
      results.push({
        type: 'tool_result',
        tool_use_id: b.id,
        content: toolResultToString(result),
        ...(isToolError(result) ? { is_error: true } : {}),
      });
    }
    history.push({ role: 'user', content: results });
  }
}
