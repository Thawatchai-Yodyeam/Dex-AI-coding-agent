import { PROVIDERS_CATALOG, effectiveEffort, type AIProvider, type ReasoningEffort } from '../../../types/agent';
import { TOOL_IMAGES_NOTE, dropOldToolImages, trimToolResults } from '../history';
import { httpError, withRetry } from '../retry';
import { readSseData, tryParseJson } from '../sse';
import { runToolCalls, toolResultToString } from '../tools';
import {
  addUsage,
  appendStepText,
  emptyUsage,
  imagesWithData,
  stepLimitNote,
  takeToolImages,
  throwIfAborted,
  type ToolImage,
  type TurnContext,
  type TurnResult,
  type UserInput,
} from '../types';

/**
 * พารามิเตอร์ระดับการคิดตามค่าย (ทุกค่ายใช้ Chat Completions แต่ชื่อพารามิเตอร์ต่างกัน)
 * - OpenAI: reasoning_effort ตรง ๆ
 * - DeepSeek: thinking.type เปิด/ปิด + reasoning_effort (low/high/max)
 * - Qwen: enable_thinking + reasoning_effort (เฉพาะ qwen3.8-max) หรือ thinking_budget
 */
export function reasoningParams(provider: AIProvider, model: string, effort: ReasoningEffort): Record<string, unknown> {
  // endpoint ที่ผู้ใช้ตั้งเอง: พารามิเตอร์ที่ server ไม่รู้จักอาจทำให้ตอบ 400 จึงไม่ส่งเลย
  if (provider === 'custom') return {};
  if (provider === 'deepseek') {
    return effort === 'none'
      ? { thinking: { type: 'disabled' } }
      : { thinking: { type: 'enabled' }, reasoning_effort: effort };
  }
  if (provider === 'qwen') {
    if (effort === 'none') return { enable_thinking: false };
    if (/^qwen3\.8-max/.test(model)) return { enable_thinking: true, reasoning_effort: effort, preserve_thinking: true };
    const budget = effort === 'low' ? 4096 : effort === 'high' ? 32768 : 16384;
    return { enable_thinking: true, thinking_budget: budget, preserve_thinking: true };
  }
  return { reasoning_effort: effort };
}

/**
 * base URL ของ custom endpoint (ตัด / และ /chat/completions ท้ายที่ผู้ใช้อาจวางมาทั้งก้อน)
 * คืน undefined สำหรับค่ายที่มี URL ตายตัว
 */
export function chatBaseUrl(provider: AIProvider, customBaseUrl?: string): string | undefined {
  if (provider !== 'custom') return undefined;
  const url = (customBaseUrl ?? '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Custom endpoint: set a Base URL such as http://localhost:11434/v1 in Settings → API keys.');
  }
  return url;
}

/** DeepSeek/Qwen โหมดคิด + tools ต้องได้ reasoning_content ของ assistant กลับไปทุกรอบ (DeepSeek ตอบ 400 ถ้าไม่ส่ง) */
function keepsReasoningContent(provider: AIProvider): boolean {
  return provider === 'deepseek' || provider === 'qwen';
}

/** Chat Completions: string ล้วนถ้าไม่มีรูป ไม่งั้นเป็น content parts (text + image_url แบบ data URL) */
export function openaiUserContent(input: UserInput): string | any[] {
  const images = imagesWithData(input);
  if (images.length === 0) return input.text;
  const parts: any[] = [];
  if (input.text.trim()) parts.push({ type: 'text', text: input.text });
  for (const img of images) {
    parts.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } });
  }
  return parts;
}

/**
 * ผลของ tool → tool message ตามลำดับ call — tool message รับได้แค่ข้อความ รูปจาก tool จึงส่งตามไป
 * เป็นข้อความ user ที่มีหัวเฉพาะ (history รู้ว่าไม่ใช่ข้อความที่ผู้ใช้พิมพ์)
 */
export function openaiToolMessages(callIds: string[], results: unknown[]): any[] {
  const images: ToolImage[] = [];
  const messages: any[] = callIds.map((id, i) => {
    const { result, images: found } = takeToolImages(results[i]);
    images.push(...found);
    return { role: 'tool', tool_call_id: id, content: toolResultToString(result) };
  });
  if (images.length > 0) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: TOOL_IMAGES_NOTE },
        ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } })),
      ],
    });
  }
  return messages;
}

export async function runOpenAITurn(ctx: TurnContext, input: UserInput): Promise<TurnResult> {
  const { settings, callbacks, signal, history } = ctx;
  const provider = settings.provider;
  const info = PROVIDERS_CATALOG.find((p) => p.id === provider);

  const baseUrl = chatBaseUrl(provider, settings.customBaseUrl) ?? info?.defaultBaseUrl ?? 'https://api.openai.com/v1';
  const model = settings.model;
  const effort = effectiveEffort(settings);

  const tools = ctx.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ctx.apiKey) headers.Authorization = `Bearer ${ctx.apiKey}`;

  history.push({ role: 'user', content: openaiUserContent(input) });

  let fullText = '';
  let fullThought = '';
  const usage = emptyUsage();

  // วนจนโมเดลตอบจบเอง — ผู้ใช้หยุดได้ด้วยปุ่ม Stop (abort signal) และถูกถามทุก STEPS_PER_CONFIRM step
  for (let step = 0; ; step++) {
    throwIfAborted(signal);
    if (ctx.shouldContinue && !(await ctx.shouldContinue(step))) {
      const note = stepLimitNote(settings.language, step);
      // ปิดเทิร์นด้วยข้อความ assistant ให้ลำดับ role ถูกต้องสำหรับเทิร์นถัดไป
      history.push({ role: 'assistant', content: note });
      return { text: appendStepText(fullText, note, false), usage };
    }
    // tool loop ยาว ๆ ทำให้ประวัติโตเกิน context ได้ภายในเทิร์นเดียว
    trimToolResults(history, 'openai');
    dropOldToolImages(history, 'openai');

    const body: Record<string, unknown> = {
      model,
      // system prompt ไม่เก็บใน history — แนบใหม่ทุกครั้ง จึงไม่ซ้ำและเปลี่ยนตาม workspace ได้
      messages: [{ role: 'system', content: ctx.systemPrompt }, ...history],
      // ไม่มี tool (ตอนสรุปบทสนทนา) ต้องไม่ส่ง field นี้เลย — OpenAI ไม่รับ array ว่าง
      ...(tools.length > 0 ? { tools } : {}),
      stream: true,
      stream_options: { include_usage: true },
    };
    Object.assign(body, reasoningParams(provider, model, effort));

    // ล้มชั่วคราว (429/5xx/เน็ตหลุดกลางสตรีม) → ลองใหม่ทั้ง step และส่งข้อความ step นี้ให้ UI ใหม่ตั้งแต่ต้น
    const textBefore = fullText;
    const thoughtBefore = fullThought;
    const { stepText, stepReasoning, toolCalls, stepUsage } = await withRetry(
      async (attempt) => {
        if (attempt > 0) {
          fullText = textBefore;
          fullThought = thoughtBefore;
          callbacks.onTextChunk('', fullText);
          callbacks.onThoughtChunk?.('', fullThought);
        }
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) throw await httpError('API Error', response);

        let stepText = '';
        let stepReasoning = '';
        let stepHasText = false;
        const stepUsage = emptyUsage();
        const toolCalls = new Map<number, { id: string; generatedId: boolean; name: string; args: string }>();

        for await (const data of readSseData(response, signal)) {
          const parsed = tryParseJson(data);
          if (!parsed) continue;
          if (parsed.error) {
            throw new Error(`API Error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
          }
          if (parsed.usage) {
            addUsage(stepUsage, {
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
              totalTokens: parsed.usage.total_tokens ?? 0,
              // OpenAI/Qwen cache อัตโนมัติ (prompt_tokens_details) ส่วน DeepSeek รายงานเป็น prompt_cache_hit_tokens
              cachedTokens: parsed.usage.prompt_tokens_details?.cached_tokens ?? parsed.usage.prompt_cache_hit_tokens ?? 0,
            });
          }

          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoning === 'string' && reasoning) {
            stepReasoning += reasoning;
            fullThought += reasoning;
            callbacks.onThoughtChunk?.(reasoning, fullThought);
          }
          if (delta.content) {
            stepText += delta.content;
            fullText = appendStepText(fullText, delta.content, stepHasText);
            stepHasText = true;
            callbacks.onTextChunk(delta.content, fullText);
          }
          for (const tc of delta.tool_calls ?? []) {
            const index = tc.index ?? 0;
            const existing = toolCalls.get(index);
            if (!existing) {
              toolCalls.set(index, {
                id: tc.id || `call_${step}_${index}_${Date.now()}`,
                generatedId: !tc.id,
                name: tc.function?.name || '',
                args: tc.function?.arguments || '',
              });
            } else {
              if (tc.id && existing.generatedId) {
                existing.id = tc.id;
                existing.generatedId = false;
              }
              if (tc.function?.name) existing.name += tc.function.name;
              if (tc.function?.arguments) existing.args += tc.function.arguments;
            }
          }
        }
        return { stepText, stepReasoning, toolCalls, stepUsage };
      },
      { signal, onRetry: callbacks.onRetry }
    );
    addUsage(usage, stepUsage);

    const calls = [...toolCalls.values()];
    const assistantMsg: Record<string, unknown> = { role: 'assistant', content: stepText || null };
    if (stepReasoning && keepsReasoningContent(provider)) assistantMsg.reasoning_content = stepReasoning;
    if (calls.length > 0) {
      assistantMsg.tool_calls = calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.args || '{}' },
      }));
    }
    history.push(assistantMsg);

    if (calls.length === 0) return { text: fullText, usage };

    const results = await runToolCalls(calls, (c) => c.name, async (call) => {
      const parsedArgs = tryParseJson(call.args || '{}');
      return parsedArgs && typeof parsedArgs === 'object'
        ? ctx.runTool(call.name, parsedArgs)
        : { error: `Invalid JSON arguments for ${call.name}: ${call.args.slice(0, 200)}` };
    });
    history.push(...openaiToolMessages(calls.map((c) => c.id), results));
  }
}
