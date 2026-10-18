import { PROVIDERS_CATALOG, effectiveEffort, type AIProvider, type ReasoningEffort } from '../../../types/agent';
import { readSseData, tryParseJson } from '../sse';
import { TOOL_DEFINITIONS, toolResultToString } from '../tools';
import {
  addUsage,
  appendStepText,
  emptyUsage,
  throwIfAborted,
  type TurnContext,
  type TurnResult,
} from '../types';

/**
 * พารามิเตอร์ระดับการคิดตามค่าย (ทุกค่ายใช้ Chat Completions แต่ชื่อพารามิเตอร์ต่างกัน)
 * - OpenAI: reasoning_effort ตรง ๆ
 * - DeepSeek: thinking.type เปิด/ปิด + reasoning_effort (low/high/max)
 * - Qwen: enable_thinking + reasoning_effort (เฉพาะ qwen3.8-max) หรือ thinking_budget
 */
export function reasoningParams(provider: AIProvider, model: string, effort: ReasoningEffort): Record<string, unknown> {
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

/** DeepSeek/Qwen โหมดคิด + tools ต้องได้ reasoning_content ของ assistant กลับไปทุกรอบ (DeepSeek ตอบ 400 ถ้าไม่ส่ง) */
function keepsReasoningContent(provider: AIProvider): boolean {
  return provider === 'deepseek' || provider === 'qwen';
}

export async function runOpenAITurn(ctx: TurnContext, userInput: string): Promise<TurnResult> {
  const { settings, callbacks, signal, history } = ctx;
  const provider = settings.provider;
  const info = PROVIDERS_CATALOG.find((p) => p.id === provider);

  const baseUrl = info?.defaultBaseUrl || 'https://api.openai.com/v1';
  const model = settings.model;
  const effort = effectiveEffort(settings);

  const tools = TOOL_DEFINITIONS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ctx.apiKey) headers.Authorization = `Bearer ${ctx.apiKey}`;

  history.push({ role: 'user', content: userInput });

  let fullText = '';
  let fullThought = '';
  const usage = emptyUsage();

  // ไม่จำกัดจำนวน step: วนจนโมเดลตอบจบเอง (ผู้ใช้หยุดได้ด้วยปุ่ม Stop → abort signal)
  for (let step = 0; ; step++) {
    throwIfAborted(signal);
    let stepHasText = false;

    const body: Record<string, unknown> = {
      model,
      // system prompt ไม่เก็บใน history — แนบใหม่ทุกครั้ง จึงไม่ซ้ำและเปลี่ยนตาม workspace ได้
      messages: [{ role: 'system', content: ctx.systemPrompt }, ...history],
      tools,
      stream: true,
      stream_options: { include_usage: true },
    };
    Object.assign(body, reasoningParams(provider, model, effort));

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw new Error(`API Error [${response.status}]: ${await response.text()}`);
    }

    let stepText = '';
    let stepReasoning = '';
    const toolCalls = new Map<number, { id: string; generatedId: boolean; name: string; args: string }>();

    for await (const data of readSseData(response, signal)) {
      const parsed = tryParseJson(data);
      if (!parsed) continue;
      if (parsed.error) {
        throw new Error(`API Error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
      }
      if (parsed.usage) {
        addUsage(usage, {
          promptTokens: parsed.usage.prompt_tokens ?? 0,
          completionTokens: parsed.usage.completion_tokens ?? 0,
          totalTokens: parsed.usage.total_tokens ?? 0,
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

    for (const call of calls) {
      const parsedArgs = tryParseJson(call.args || '{}');
      const result = parsedArgs && typeof parsedArgs === 'object'
        ? await ctx.runTool(call.name, parsedArgs)
        : { error: `Invalid JSON arguments for ${call.name}: ${call.args.slice(0, 200)}` };
      history.push({ role: 'tool', tool_call_id: call.id, content: toolResultToString(result) });
    }
  }
}
