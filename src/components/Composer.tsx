import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square, Brain, ChevronDown, ImagePlus, X } from 'lucide-react';
import type { AIProvider, AppSettings, ImageAttachment, ReasoningEffort, TokenUsage } from '../types/agent';
import { PROVIDERS_CATALOG, effectiveEffort, findModel, supportsImages } from '../types/agent';
import type { Translation } from '../utils/i18n';
import {
  ImageAttachError,
  MAX_IMAGES_PER_MESSAGE,
  SUPPORTED_IMAGE_TYPES,
  fileToImageAttachment,
  imageSrc,
} from '../utils/images';
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
  images: ImageAttachment[];
  onImagesChange: React.Dispatch<React.SetStateAction<ImageAttachment[]>>;
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
  images,
  onImagesChange,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const visionOk = supportsImages(settings.provider);

  useEffect(() => {
    if (!imageError) return;
    const id = setTimeout(() => setImageError(null), 4000);
    return () => clearTimeout(id);
  }, [imageError]);

  const addFiles = async (files: File[]) => {
    const picked = files.filter((f) => f.type.startsWith('image/'));
    if (picked.length === 0) return;
    if (!visionOk) {
      setImageError(t.imageUnsupportedProvider);
      return;
    }
    const room = MAX_IMAGES_PER_MESSAGE - images.length;
    if (room <= 0) {
      setImageError(t.imageTooMany(MAX_IMAGES_PER_MESSAGE));
      return;
    }
    if (picked.length > room) setImageError(t.imageTooMany(MAX_IMAGES_PER_MESSAGE));
    const added: ImageAttachment[] = [];
    for (const file of picked.slice(0, room)) {
      try {
        added.push(await fileToImageAttachment(file));
      } catch (err) {
        const code = err instanceof ImageAttachError ? err.code : 'decode';
        setImageError(code === 'unsupported' ? t.imageBadType : code === 'too_large' ? t.imageTooLarge : t.imageDecodeFailed);
      }
    }
    // อ่านไฟล์เป็น async — ใช้ updater กันทับรูปที่เพิ่มเข้ามาระหว่างรอ
    if (added.length > 0) onImagesChange((prev) => [...prev, ...added].slice(0, MAX_IMAGES_PER_MESSAGE));
  };

  const canSend = !!value.trim() || images.length > 0;

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
    <div
      className={`composer ${dragOver ? 'is-drag-over' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragOver(false);
        void addFiles([...e.dataTransfer.files]);
      }}
    >
      {images.length > 0 && (
        <ul className="composer-attachments" aria-label={t.attachedImages}>
          {images.map((img) => (
            <li key={img.id} className="attachment-thumb" title={img.name}>
              <img src={imageSrc(img)} alt={img.name} />
              <button
                type="button"
                className="attachment-remove"
                onClick={() => onImagesChange((prev) => prev.filter((i) => i.id !== img.id))}
                aria-label={`${t.removeImage}: ${img.name}`}
                title={t.removeImage}
              >
                <X size={12} strokeWidth={2.6} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
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
        onPaste={(e) => {
          const files = [...e.clipboardData.items]
            .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
            .map((item) => item.getAsFile())
            .filter((f): f is File => !!f);
          if (files.length === 0) return;
          // วางรูป: ไม่ให้ชื่อไฟล์/ข้อความแปลก ๆ ติดมาในช่องพิมพ์
          e.preventDefault();
          void addFiles(files);
        }}
        onKeyDown={(e) => {
          // isComposing: กำลังเลือกคำจาก IME (ไทย/จีน/ญี่ปุ่น) — Enter ยังไม่ใช่การส่ง
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!isRunning && canSend) onSend();
          }
        }}
      />

      {imageError && (
        <p className="composer-error" role="alert">
          {imageError}
        </p>
      )}

      <div className="composer-toolbar">
        <input
          ref={fileInputRef}
          type="file"
          accept={SUPPORTED_IMAGE_TYPES.join(',')}
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            void addFiles(files);
          }}
        />
        <button
          type="button"
          className="icon-btn icon-btn-sm composer-attach"
          onClick={() => fileInputRef.current?.click()}
          disabled={!visionOk || images.length >= MAX_IMAGES_PER_MESSAGE}
          aria-label={t.attachImage}
          title={visionOk ? t.attachImageHint : t.imageUnsupportedProvider}
        >
          <ImagePlus size={17} aria-hidden="true" />
        </button>
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
              disabled={!canSend}
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
