import { describe, expect, it } from 'vitest';
import { PROVIDERS_CATALOG, defaultModelFor, effectiveEffort } from './agent';

describe('PROVIDERS_CATALOG', () => {
  it('has exactly the five supported vendors', () => {
    expect(PROVIDERS_CATALOG.map((p) => p.id)).toEqual(['google', 'anthropic', 'openai', 'deepseek', 'qwen']);
  });

  it('gives every model a default effort it actually supports and one default model per vendor', () => {
    for (const p of PROVIDERS_CATALOG) {
      expect(p.models.filter((m) => m.isDefault)).toHaveLength(1);
      for (const m of p.models) expect(m.efforts).toContain(m.defaultEffort);
    }
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
