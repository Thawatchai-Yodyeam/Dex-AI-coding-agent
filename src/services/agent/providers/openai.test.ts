import { describe, expect, it } from 'vitest';
import { reasoningParams } from './openai';

describe('reasoningParams', () => {
  it('passes the effort straight through for OpenAI', () => {
    expect(reasoningParams('openai', 'gpt-6.1-sol', 'xhigh')).toEqual({ reasoning_effort: 'xhigh' });
    expect(reasoningParams('openai', 'gpt-6.1-sol', 'none')).toEqual({ reasoning_effort: 'none' });
  });

  it('toggles DeepSeek thinking and sets its effort', () => {
    expect(reasoningParams('deepseek', 'deepseek-flash', 'none')).toEqual({ thinking: { type: 'disabled' } });
    expect(reasoningParams('deepseek', 'deepseek-v4-pro', 'max')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
  });

  it('uses reasoning_effort for qwen3.8-max and thinking_budget for other Qwen models', () => {
    expect(reasoningParams('qwen', 'qwen3.8-max', 'none')).toEqual({ enable_thinking: false });
    expect(reasoningParams('qwen', 'qwen3.8-max', 'xhigh')).toEqual({
      enable_thinking: true,
      reasoning_effort: 'xhigh',
      preserve_thinking: true,
    });
    expect(reasoningParams('qwen', 'qwen3.8-flash', 'low')).toEqual({
      enable_thinking: true,
      thinking_budget: 4096,
      preserve_thinking: true,
    });
  });
});
