import React from 'react';
import type { AIProvider, AppSettings } from '../types/agent';
import { PROVIDERS_CATALOG, modelsFor } from '../types/agent';

/** ค่าของ <option> = `provider::model` */
export function modelOptionValue(provider: AIProvider, model: string): string {
  return `${provider}::${model}`;
}

/** แยกกลับ — ชื่อโมเดลของ custom endpoint อาจมี `:` (เช่น qwen3:32b) จึงตัดที่ `::` แรกเท่านั้น */
export function parseModelOptionValue(value: string): { provider: AIProvider; model: string } {
  const sep = value.indexOf('::');
  return { provider: value.slice(0, sep) as AIProvider, model: value.slice(sep + 2) };
}

/** optgroup ของทุกค่าย — ค่ายที่ไม่มีโมเดล (custom ที่ยังไม่ตั้ง) ไม่แสดง */
export const ModelOptions: React.FC<{ settings: Pick<AppSettings, 'customModels'> }> = ({ settings }) => (
  <>
    {PROVIDERS_CATALOG.map((p) => {
      const models = modelsFor(p.id, settings);
      if (models.length === 0) return null;
      return (
        <optgroup key={p.id} label={p.name}>
          {models.map((m) => (
            <option key={m.id} value={modelOptionValue(p.id, m.id)}>
              {m.name}
            </option>
          ))}
        </optgroup>
      );
    })}
  </>
);
