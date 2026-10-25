import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { effectiveEffort } from '../../../types/agent';
import { dropOldToolImages, trimToolResults } from '../history';
import { withRetry } from '../retry';
import { runToolCalls } from '../tools';
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

const DEFAULT_MODEL = 'gemini-3.8-flash';

function thinkingConfig(model: string, effort: string): Record<string, unknown> | undefined {
  if (effort === 'none') return undefined;
  // Gemini 2.x ใช้ thinkingBudget, Gemini 3.x ใช้ thinkingLevel
  if (/^gemini-2/.test(model)) {
    const budget = effort === 'low' ? 2048 : effort === 'high' ? 24576 : 8192;
    return { includeThoughts: true, thinkingBudget: budget };
  }
  const level =
    effort === 'minimal'
      ? ThinkingLevel.MINIMAL
      : effort === 'low'
        ? ThinkingLevel.LOW
        : effort === 'medium'
          ? ThinkingLevel.MEDIUM
          : ThinkingLevel.HIGH;
  return { includeThoughts: true, thinkingLevel: level };
}

/** รวม text part ที่ติดกันซึ่งไม่มี signature เพื่อไม่ให้ history บวมเป็นพัน part ระหว่างสตรีม */
function appendPart(parts: any[], part: any) {
  const last = parts[parts.length - 1];
  const isPlainText = (p: any) =>
    p && typeof p.text === 'string' && !p.functionCall && !p.thoughtSignature;
  if (isPlainText(part) && isPlainText(last) && !!last.thought === !!part.thought) {
    last.text += part.text;
  } else {
    parts.push({ ...part });
  }
}

export function googleUserParts(input: UserInput): any[] {
  const parts: any[] = imagesWithData(input).map((img) => ({ inlineData: { mimeType: img.mediaType, data: img.data } }));
  if (input.text.trim() || parts.length === 0) parts.push({ text: input.text });
  return parts;
}

/** ผลของ tool → functionResponse part — Gemini 3 รับรูปในผลของ function ได้ (multimodal function response) */
export function googleFunctionResponse(name: string, raw: unknown): any {
  const { result, images } = takeToolImages(raw);
  return {
    functionResponse: {
      name,
      response: result,
      ...(images.length ? { parts: images.map((img) => ({ inlineData: { mimeType: img.mediaType, data: img.data } })) } : {}),
    },
  };
}

export async function runGoogleTurn(ctx: TurnContext, input: UserInput): Promise<TurnResult> {
  const { settings, callbacks, signal, history } = ctx;
  const ai = new GoogleGenAI({ apiKey: ctx.apiKey });
  const model = settings.model || DEFAULT_MODEL;

  const tools = [
    {
      functionDeclarations: ctx.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parametersJsonSchema: t.parameters,
      })),
    },
  ];

  history.push({ role: 'user', parts: googleUserParts(input) });

  let fullText = '';
  let fullThought = '';
  const usage = emptyUsage();

  // วนจนโมเดลตอบจบเอง — ผู้ใช้หยุดได้ด้วยปุ่ม Stop (abort signal) และถูกถามทุก STEPS_PER_CONFIRM step
  for (let step = 0; ; step++) {
    throwIfAborted(signal);
    if (ctx.shouldContinue && !(await ctx.shouldContinue(step))) {
      const note = stepLimitNote(settings.language, step);
      // ปิดเทิร์นด้วยข้อความ model — Gemini ไม่รับ user ติดกันในเทิร์นถัดไป
      history.push({ role: 'model', parts: [{ text: note }] });
      return { text: appendStepText(fullText, note, false), usage };
    }
    // tool loop ยาว ๆ ทำให้ประวัติโตเกิน context ได้ภายในเทิร์นเดียว
    trimToolResults(history, 'google');
    dropOldToolImages(history, 'google');

    // ล้มชั่วคราว (429/5xx/เน็ตหลุดกลางสตรีม) → ลองใหม่ทั้ง step และส่งข้อความ step นี้ให้ UI ใหม่ตั้งแต่ต้น
    const textBefore = fullText;
    const thoughtBefore = fullThought;
    const { modelParts, calls, stepUsage } = await withRetry(
      async (attempt) => {
        if (attempt > 0) {
          fullText = textBefore;
          fullThought = thoughtBefore;
          callbacks.onTextChunk('', fullText);
          callbacks.onThoughtChunk?.('', fullThought);
        }
        const stream = await ai.models.generateContentStream({
          model,
          contents: history,
          config: {
            systemInstruction: ctx.systemPrompt,
            ...(ctx.tools.length > 0 ? { tools } : {}),
            thinkingConfig: thinkingConfig(model, effectiveEffort(settings)),
            abortSignal: signal,
          },
        });

        // เก็บ part ทุกชนิดตามที่โมเดลส่งมา (รวม thoughtSignature) — Gemini 3 ต้องได้ signature
        // กลับมาพร้อม functionCall ในรอบถัดไป ไม่งั้นตอบ 400
        const modelParts: any[] = [];
        const calls: { name: string; args: Record<string, any> }[] = [];
        let stepUsage = emptyUsage();
        let stepHasText = false;

        for await (const chunk of stream) {
          throwIfAborted(signal);
          const u = chunk.usageMetadata;
          if (u) {
            stepUsage = {
              promptTokens: u.promptTokenCount ?? 0,
              completionTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
              totalTokens: u.totalTokenCount ?? 0,
              cachedTokens: u.cachedContentTokenCount ?? 0,
            };
          }
          for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
            // thought summary ไม่ต้องส่งกลับ เว้นแต่มี signature ติดมา
            if (!part.thought || part.thoughtSignature) appendPart(modelParts, part);
            if (part.thought) {
              const piece = part.text ?? '';
              fullThought += piece;
              if (piece) callbacks.onThoughtChunk?.(piece, fullThought);
            } else if (part.text) {
              fullText = appendStepText(fullText, part.text, stepHasText);
              stepHasText = true;
              callbacks.onTextChunk(part.text, fullText);
            }
            if (part.functionCall) {
              calls.push({
                name: part.functionCall.name || 'unknown',
                args: (part.functionCall.args as Record<string, any>) || {},
              });
            }
          }
        }
        return { modelParts, calls, stepUsage };
      },
      { signal, onRetry: callbacks.onRetry }
    );
    addUsage(usage, stepUsage);

    if (modelParts.length > 0) history.push({ role: 'model', parts: modelParts });
    if (calls.length === 0) return { text: fullText, usage };

    const responses = await runToolCalls(calls, (c) => c.name, async (call) =>
      googleFunctionResponse(call.name, await ctx.runTool(call.name, call.args))
    );
    history.push({ role: 'user', parts: responses });
  }
}
