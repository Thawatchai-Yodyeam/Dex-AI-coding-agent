import { describe, expect, it } from 'vitest';
import { PROVIDERS_CATALOG, customModelIds, defaultModelFor, effectiveEffort, findModel, modelsFor } from './agent';

describe('PROVIDERS_CATALOG', () => {
  it('has the five supported vendors plus a custom endpoint', () => {
    expect(PROVIDERS_CATALOG.map((p) => p.id)).toEqual(['google', 'anthropic', 'openai', 'deepseek', 'qwen', 'custom']);
  });

  it('gives every model a default effort it actually supports and one default model per vendor', () => {
    for (const p of PROVIDERS_CATALOG.filter((p) => p.id !== 'custom')) {
      expect(p.models.filter((m) => m.isDefault)).toHaveLength(1);
      for (const m of p.models) expect(m.efforts).toContain(m.defaultEffort);
    }
  });
});

describe('custom endpoint models', () => {
  it('reads a de-duplicated list from settings and never sends a reasoning effort', () => {
    const settings = { customModels: ' llama3.3, qwen3:32b\nllama3.3 ,, ' };
    expect(customModelIds(settings)).toEqual(['llama3.3', 'qwen3:32b']);
    expect(modelsFor('custom', settings).map((m) => m.id)).toEqual(['llama3.3', 'qwen3:32b']);
    expect(modelsFor('openai', settings).length).toBeGreaterThan(0);
    expect(findModel('custom', 'anything')?.efforts).toEqual(['none']);
    expect(effectiveEffort({ provider: 'custom', model: 'llama3.3', reasoningEffort: 'high' })).toBe('none');
  });
});

describe('effectiveEffort', () => {
  it('keeps a supported effort', () => {
    expect(effectiveEffort({ provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'max' })).toBe('max');
  });

  it('falls back to the model default when the effort is not supported', () => {
    // Opus 5.5 ปิด thinking ไม่ได้ → 'none' ไม่อยู่ในรายการ
    expect(effectiveEffort({ provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'none' })).toBe('high');
    expect(effectiveEffort({ provider: 'google', model: defaultModelFor('google'), reasoningEffort: 'xhigh' })).toBe('medium');
  });
});
