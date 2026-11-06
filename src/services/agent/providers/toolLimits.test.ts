import { describe, expect, it, vi } from 'vitest';

vi.mock('../../tauriBridge', () => ({ tauriBridge: {} }));

import type { AIProvider, AppSettings } from '../../../types/agent';
import { translations } from '../../../utils/i18n';
import { TransientApiError } from '../retry';
import { AgentAbortError } from '../types';
import { explainToolLimitError, toolLimitOf, withToolLimitErrors } from './toolLimits';

const tools = (mcp: number, builtIn = 20) => [
  ...Array.from({ length: builtIn }, (_, i) => ({ name: `tool_${i}`, description: '', parameters: {} })),
  ...Array.from({ length: mcp }, (_, i) => ({ name: `mcp__s__t${i}`, description: '', parameters: {} })),
];
const ctx = (count: number, provider: AIProvider = 'openai', language: AppSettings['language'] = 'en') => ({
  settings: { provider, language } as AppSettings,
  tools: tools(count),
});
const explain = (err: unknown, c = ctx(121)) => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const result = explainToolLimitError(err, c);
  warn.mockRestore();
  return result;
};

/** ข้อความจริงจาก API ที่มีรายงานไว้ */
const OPENAI_TOO_LONG =
  `API Error [400]: {"error":{"message":"Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length 141 instead.","type":"invalid_request_error","param":"tools","code":"array_above_max_length"}}`;
const GEMINI_TOO_MANY =
  '{"error":{"code":400,"message":"The GenerateContentRequest proto is invalid:\\n  * tools[0].function_declarations: [FIELD_INVALID] At most 512 function declarations can be specified.","status":"INVALID_ARGUMENT"}}';
const GEMINI_TOO_COMPLEX =
  '{"error":{"code":400,"message":"The specified schema produces a constraint that has too many states for serving. Typical causes of this error are schemas with lots of text","status":"INVALID_ARGUMENT"}}';
const GEMINI_VAGUE = '{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}';

describe('explainToolLimitError', () => {
  it('turns the OpenAI refusal into a sentence with the limit, the count and the fix', () => {
    const err = explain(new Error(OPENAI_TOO_LONG), ctx(121));
    expect(err?.message).toBe(`${translations.en.toolLimitExceeded('OpenAI GPT', 128, 141)} ${translations.en.toolLimitFix(13)}`);
    expect(err?.message).not.toContain('invalid_request_error');
  });

  it('uses the count Dex really sent, not the one quoted by the API', () => {
    const message = explain(new Error(OPENAI_TOO_LONG), ctx(120))!.message;
    expect(message).toContain('140');
    expect(message).toContain('at least 12 tools');
  });

  it('reads the limit from the Gemini refusal', () => {
    const message = explain(Object.assign(new Error(GEMINI_TOO_MANY), { status: 400 }), ctx(600, 'google'))!.message;
    expect(message).toContain('Google Gemini');
    expect(message).toContain('at most 512');
    expect(message).toContain('at least 108 tools');
  });

  it('names no limit when the provider only says the schemas are too complex', () => {
    const message = explain(Object.assign(new Error(GEMINI_TOO_COMPLEX), { status: 400 }), ctx(219, 'google'))!.message;
    expect(message).toBe(`${translations.en.toolLimitLikely('Google Gemini', 239)} ${translations.en.toolLimitFix(null)}`);
  });

  it.each([
    "'$.tools' is too long. Maximum length is 128, but got 221 items.",
    'tools: List should have at most 128 items after validation, not 150',
    'Too many tools provided',
    'You provided more than the limit of 128 tools',
    'The number of function declarations exceeds the maximum allowed',
    'At most 128 tools can be specified',
  ])('recognises other wording: %s', (text) => {
    expect(explain(new Error(`API Error [400]: {"error":{"message":"${text}"}}`))).not.toBeNull();
  });

  it.each([
    `Invalid 'tools[3].function.name': string too long. Expected a string with maximum length 64, but got a string with length 80 instead.`,
    'tools.12.custom.name: String should have at most 128 characters',
    'tools.0.input_schema: JSON schema is invalid',
    'Tool names must be unique.',
    'registry.ollama.ai/library/llama3 does not support tools',
    "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
    'Range of max_tokens should be [1, 8192]',
    'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.',
    'Too many requests',
  ])('leaves other errors alone: %s', (text) => {
    expect(explain(new Error(`API Error [400]: {"error":{"message":"${text.replace(/"/g, '\\"')}"}}`))).toBeNull();
  });

  it('blames the tools for a vague 400 only when there are clearly a lot of them', () => {
    const vague = () => Object.assign(new Error(GEMINI_VAGUE), { status: 400 });
    expect(explain(vague(), ctx(219, 'google'))?.message).toContain('239');
    // จำนวนปกติ: 400 แบบนี้มาจากอย่างอื่น ต้องเห็นข้อความเดิม
    expect(explain(vague(), ctx(20, 'google'))).toBeNull();
    // OpenAI เปลี่ยนถ้อยคำในอนาคต แต่ยังชี้ว่าทั้งรายการมีปัญหา
    const reworded = new Error('API Error [400]: {"error":{"message":"Your tool list was refused.","param":"tools"}}');
    expect(explain(reworded, ctx(121))).not.toBeNull();
    expect(explain(reworded, ctx(20))).toBeNull();
  });

  it('does not blame the tools for a bad API key, whatever their number', () => {
    const badKey = Object.assign(new Error('{"error":{"code":400,"message":"API key not valid.","status":"INVALID_ARGUMENT"}}'), { status: 400 });
    expect(explain(badKey, ctx(300, 'google'))).toBeNull();
  });

  it('leaves transient errors, aborts and requests without tools alone', () => {
    expect(explain(new TransientApiError(OPENAI_TOO_LONG, 500))).toBeNull();
    expect(explain(new AgentAbortError())).toBeNull();
    expect(explain(new Error(OPENAI_TOO_LONG), { settings: ctx(0).settings, tools: [] })).toBeNull();
  });

  it('does not suggest turning off MCP tools when that cannot help', () => {
    expect(explain(new Error(OPENAI_TOO_LONG), { settings: ctx(0).settings, tools: tools(0, 140) })!.message).toContain(translations.en.toolLimitFixElsewhere);
    // เกิน 12 ตัว แต่มี MCP แค่ 5 ตัว
    expect(explain(new Error(OPENAI_TOO_LONG), { settings: ctx(0).settings, tools: tools(5, 135) })!.message).toContain(translations.en.toolLimitFixElsewhere);
  });

  it('speaks the language of the app', () => {
    expect(explain(new Error(OPENAI_TOO_LONG), ctx(121, 'openai', 'th'))!.message).toContain('รับ tool ได้ไม่เกิน 128 ตัว');
  });
});

describe('toolLimitOf', () => {
  it('only states limits that have a source', () => {
    expect(toolLimitOf('openai')).toBe(128);
    expect(toolLimitOf('google')).toBe(512);
    for (const provider of ['anthropic', 'deepseek', 'qwen', 'custom'] as const) expect(toolLimitOf(provider)).toBeNull();
  });
});

describe('withToolLimitErrors', () => {
  it('passes results and unrelated errors through untouched', async () => {
    const result = { text: 'ok', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    await expect(withToolLimitErrors(async () => result)(ctx(1) as any, { text: '' })).resolves.toBe(result);
    const other = new Error('API Error [401]: bad key');
    await expect(withToolLimitErrors(async () => Promise.reject(other))(ctx(1) as any, { text: '' })).rejects.toBe(other);
  });

  it('replaces a tool limit error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(withToolLimitErrors(async () => Promise.reject(new Error(OPENAI_TOO_LONG)))(ctx(121) as any, { text: '' })).rejects.toThrow(
      /at most 128 tools/
    );
    warn.mockRestore();
  });
});
