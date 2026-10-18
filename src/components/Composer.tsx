import React, { useEffect, useRef } from 'react';
import { ArrowUp, Square, Brain, ChevronDown } from 'lucide-react';
import type { AIProvider, AppSettings, ReasoningEffort, TokenUsage } from '../types/agent';
import { PROVIDERS_CATALOG, effectiveEffort, findModel } from '../types/agent';
import type { Translation } from '../utils/i18n';
import { TokenUsageChip } from './TokenUsageChip';

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  isRunning: boolean;
  settings: AppSettings;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  sessionTokens: number;
  lastTokenUsage: TokenUsage | null;
  onResetTokens: () => void;
  placeholder: string;
  t: Translation;
  autoFocus?: boolean;
  /** แสดงตัวนับ token (ซ่อนในหน้าแชทว่าง) */
  showTokens?: boolean;
}

const MAX_TEXTAREA_PX = 280;

export const Composer: React.FC<ComposerProps> = ({
  value,
  onChange,
  onSend,
  onStop,
  isRunning,
  settings,
  onUpdateSettings,
  sessionTokens,
  lastTokenUsage,
  onResetTokens,
  placeholder,
  t,
  autoFocus,
  showTokens = true,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ขยายความสูงตามเนื้อหา
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // ว่าง = ความสูงปกติ 1 บรรทัด (วัดตอน mount อาจได้ค่าผิดเพราะ placeholder ห่อบรรทัดก่อน layout เสร็จ)
    if (!value) {
      el.style.height = '';
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const modelValue = `${settings.provider}::${settings.model}`;
  const currentProvider = PROVIDERS_CATALOG.find((p) => p.id === settings.provider);
  const currentModel = currentProvider?.models.find((m) => m.id === settings.model);
  const currentModelName = currentModel?.name ?? settings.model;

  const effortLabels: Record<ReasoningEffort, string> = {
    none: t.effortNone,
    minimal: t.effortMinimal,
    low: t.effortLow,
    medium: t.effortMedium,
    high: t.effortHigh,
    xhigh: t.effortXhigh,
    max: t.effortMax,
  };
  // แสดงเฉพาะระดับที่โมเดลปัจจุบันรองรับ
  const efforts = currentModel?.efforts ?? [];

  return (
    <div className="composer">
      <label htmlFor="composer-input" className="sr-only">
        {t.composerLabel}
      </label>
      <textarea
        id="composer-input"
        ref={textareaRef}
        className="composer-input"
        rows={1}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // isComposing: กำลังเลือกคำจาก IME (ไทย/จีน/ญี่ปุ่น) — Enter ยังไม่ใช่การส่ง
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!isRunning) onSend();
          }
        }}
      />

      <div className="composer-toolbar">
        <div className="select-pill" title={t.effortLabel}>
          <Brain size={15} aria-hidden="true" />
          <label htmlFor="effort-select" className="sr-only">
            {t.effortLabel}
          </label>
          <select
            id="effort-select"
            value={effectiveEffort(settings)}
            onChange={(e) => onUpdateSettings({ reasoningEffort: e.target.value as ReasoningEffort })}
          >
            {efforts.map((key) => (
              <option key={key} value={key}>
                {effortLabels[key]}
              </option>
            ))}
          </select>
        </div>

        <div className="composer-toolbar-right">
          {showTokens && (
            <TokenUsageChip
              sessionTokens={sessionTokens}
              lastTokenUsage={lastTokenUsage}
              t={t}
              onReset={onResetTokens}
            />
          )}

          <div className="select-pill select-pill-plain model-pill">
            <label htmlFor="model-select" className="sr-only">
              {t.modelLabel}
            </label>
            <span className="model-pill-text" aria-hidden="true">
              {currentModelName}
            </span>
            <ChevronDown size={14} aria-hidden="true" />
            {/* select โปร่งใสวางทับ — ได้ dropdown แบบ native (เข้าถึงด้วยคีย์บอร์ดได้) แต่หน้าตาเรียบแบบ Claude */}
            <select
              id="model-select"
              className="overlay-select"
              value={modelValue}
              onChange={(e) => {
                const [provider, model] = e.target.value.split('::') as [AIProvider, string];
                // เปลี่ยนโมเดล → ใช้ effort เริ่มต้นของโมเดลนั้น (แต่ละโมเดลรองรับคนละชุด)
                onUpdateSettings({ provider, model, reasoningEffort: findModel(provider, model)?.defaultEffort ?? 'medium' });
              }}
            >
              {PROVIDERS_CATALOG.map((p) => (
                <optgroup key={p.id} label={p.name}>
                  {p.models.map((m) => (
                    <option key={m.id} value={`${p.id}::${m.id}`}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          {isRunning ? (
            <button type="button" className="send-btn is-stop" onClick={onStop} aria-label={t.stopBtn} title={t.stopBtn}>
              <Square size={14} fill="currentColor" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="send-btn"
              onClick={onSend}
              disabled={!value.trim()}
              aria-label={t.send}
              title={t.send}
            >
              <ArrowUp size={18} strokeWidth={2.4} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
