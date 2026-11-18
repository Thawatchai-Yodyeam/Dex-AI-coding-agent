import React, { useState, useEffect, useRef } from 'react';
import { X, KeyRound, SlidersHorizontal, ShieldCheck, Puzzle, ImagePlus, Ban, Brain } from 'lucide-react';
import { MEMORY_MAX_CHARS } from '../services/agent/memory';
import { fileToWallpaper } from '../utils/images';
import { WALLPAPER_PRESETS, presetValue, resolveWallpaper } from '../utils/wallpapers';
import { McpSettings } from './McpSettings';
import { SkillsSettings } from './SkillsSettings';
import type { AppSettings, AIProvider, PokemonTheme, ThemePreference } from '../types/agent';
import { PROVIDERS_CATALOG, customModelIds, findModel } from '../types/agent';
import { ModelOptions, modelOptionValue, parseModelOptionValue } from './ModelOptions';
import { tauriBridge } from '../services/tauriBridge';
import { translations } from '../utils/i18n';
import { PermissionRulesEditor } from './PermissionRulesEditor';

export type SettingsTab = 'general' | 'keys' | 'permissions' | 'memory' | 'extensions';

/** memory หนึ่งขอบเขตในฟอร์ม: ค่าที่โหลดมา (เทียบว่าแก้ไหม) + ที่กำลังแก้ */
interface MemoryDraft {
  path: string;
  loaded: string;
  value: string;
}
const EMPTY_MEMORY: MemoryDraft = { path: '', loaded: '', value: '' };
type Tab = SettingsTab;

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSave: (newSettings: AppSettings) => void;
  /** แท็บที่จะเปิดไปหา ไม่ระบุ = แท็บล่าสุด */
  initialTab?: SettingsTab;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, settings, onSave, initialTab }) => {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [tab, setTab] = useState<Tab>('general');
  const [saved, setSaved] = useState(false);
  const [wallpaperError, setWallpaperError] = useState(false);
  // key ของ search API ไม่อยู่ใน settings — พิมพ์แล้วบันทึกลง Credential Manager ตรง ๆ ตอนกดบันทึก
  const [searchKey, setSearchKey] = useState('');
  const [searchKeyStatus, setSearchKeyStatus] = useState<Record<string, boolean>>({});
  // memory อยู่ในไฟล์ ไม่อยู่ใน settings — โหลดตอนเปิด บันทึกเฉพาะที่แก้ตอนกดบันทึก
  const [userMemory, setUserMemory] = useState<MemoryDraft>(EMPTY_MEMORY);
  const [projectMemory, setProjectMemory] = useState<MemoryDraft>(EMPTY_MEMORY);
  const dialogRef = useRef<HTMLDivElement>(null);
  const wallpaperInputRef = useRef<HTMLInputElement>(null);

  // รีเซ็ตฟอร์มเมื่อเปิดใหม่เท่านั้น (เดิมรีเซ็ตทุกครั้งที่ settings เปลี่ยน ทำให้สิ่งที่พิมพ์ค้างหาย)
  useEffect(() => {
    if (isOpen) {
      setDraft(settings);
      setSaved(false);
      setWallpaperError(false);
      setSearchKey('');
      setUserMemory(EMPTY_MEMORY);
      setProjectMemory(EMPTY_MEMORY);
      const toDraft = (m: { path: string; content: string }): MemoryDraft => ({ path: m.path, loaded: m.content, value: m.content });
      tauriBridge.readMemory('user').then((m) => setUserMemory(toDraft(m))).catch(() => {});
      if (settings.cwd) tauriBridge.readMemory('project', settings.cwd).then((m) => setProjectMemory(toDraft(m))).catch(() => {});
      tauriBridge
        .webSearchKeyStatus()
        .then(setSearchKeyStatus)
        .catch(() => setSearchKeyStatus({}));
      if (initialTab) setTab(initialTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // พรีวิวภาษาตามที่เลือกในฟอร์มทันที
  const t = translations[draft.language];
  const patch = (p: Partial<AppSettings>) => setDraft((d) => ({ ...d, ...p }));
  const setKey = (id: AIProvider, value: string) => setDraft((d) => ({ ...d, apiKeys: { ...d.apiKeys, [id]: value } }));
  const draftWallpaperUrl = resolveWallpaper(draft.wallpaper);
  const activeKeys = Object.values(draft.apiKeys).filter((k) => k.trim()).length;

  const searchProvider = draft.webSearchProvider ?? 'off';
  const removeSearchKey = () => {
    if (searchProvider === 'off') return;
    tauriBridge
      .saveWebSearchKey(searchProvider, '')
      .then(() => tauriBridge.webSearchKeyStatus().then(setSearchKeyStatus))
      .catch((e) => console.error('Failed to remove web search key:', e));
  };

  const memoryTooLong = [userMemory, projectMemory].some((m) => m.value.length > MEMORY_MAX_CHARS);

  const handleSave = () => {
    if (memoryTooLong) {
      setTab('memory');
      return;
    }
    // memory ของ workspace ที่เปิดตอนเปิดหน้านี้ — ถ้าเปลี่ยน workspace ในฟอร์ม ก็ยังเขียนไฟล์ของ workspace เดิม
    const writes: Promise<unknown>[] = [];
    if (userMemory.value !== userMemory.loaded) writes.push(tauriBridge.writeMemory('user', undefined, userMemory.value));
    if (settings.cwd && projectMemory.value !== projectMemory.loaded) {
      writes.push(tauriBridge.writeMemory('project', settings.cwd, projectMemory.value));
    }
    Promise.all(writes).catch((e) => console.error('Failed to save memory:', e));
    if (searchProvider !== 'off' && searchKey.trim()) {
      tauriBridge.saveWebSearchKey(searchProvider, searchKey).catch((e) => console.error('Failed to save web search key:', e));
    }
    // แก้รายชื่อโมเดลของ custom endpoint จนโมเดลที่เลือกอยู่หายไป → ใช้ตัวแรกของรายการใหม่
    const customIds = customModelIds(draft);
    const model = draft.provider === 'custom' && !customIds.includes(draft.model) ? (customIds[0] ?? '') : draft.model;
    onSave({
      ...draft,
      model,
      cwd: draft.cwd.trim(),
      customBaseUrl: draft.customBaseUrl?.trim(),
    });
    setSaved(true);
    setTimeout(onClose, 500);
  };

  const themes: { id: ThemePreference; label: string }[] = [
    { id: 'light', label: t.themeLight },
    { id: 'dark', label: t.themeDark },
    { id: 'system', label: t.themeSystem },
  ];
  // สีตัวอย่างของแต่ละธีม: [พื้นหลัง, สีหลัก]
  const pokemonThemes: { id: PokemonTheme; label: string; swatch: [string, string] }[] = [
    { id: 'pikachu', label: t.themePikachu, swatch: ['#17150f', '#f7d02c'] },
    { id: 'pokeball', label: t.themePokeball, swatch: ['#181616', '#ef4136'] },
    { id: 'squirtle', label: t.themeSquirtle, swatch: ['#f3f8fb', '#1f7fc4'] },
    { id: 'bulbasaur', label: t.themeBulbasaur, swatch: ['#142220', '#5fd18b'] },
    { id: 'gengar', label: t.themeGengar, swatch: ['#1b1625', '#b77cf2'] },
  ];
  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'general', label: t.tabGeneral, icon: <SlidersHorizontal size={16} aria-hidden="true" /> },
    { id: 'keys', label: `${t.tabApiKeys} (${t.keysActive(activeKeys)})`, icon: <KeyRound size={16} aria-hidden="true" /> },
    { id: 'permissions', label: t.tabPermissions, icon: <ShieldCheck size={16} aria-hidden="true" /> },
    { id: 'memory', label: t.tabMemory, icon: <Brain size={16} aria-hidden="true" /> },
    { id: 'extensions', label: t.tabExtensions, icon: <Puzzle size={16} aria-hidden="true" /> },
  ];

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <nav className="modal-nav">
          <h2 id="settings-title" className="modal-title">
            {t.settingsTitle}
          </h2>
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${tab === item.id ? 'is-active' : ''}`}
              aria-pressed={tab === item.id}
              onClick={() => setTab(item.id)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>

        <section className="modal-content">
          <button type="button" className="icon-btn modal-close" onClick={onClose} aria-label={t.cancelBtn}>
            <X size={18} aria-hidden="true" />
          </button>

          <div className="modal-scroll">
            {tab === 'general' && (
              <>
                <fieldset className="field">
                  <legend className="field-label">{t.themeLabel}</legend>
                  <div className="segmented">
                    {themes.map((th) => (
                      <button
                        key={th.id}
                        type="button"
                        className={`segment ${(draft.theme ?? 'system') === th.id ? 'is-active' : ''}`}
                        aria-pressed={(draft.theme ?? 'system') === th.id}
                        onClick={() => patch({ theme: th.id })}
                      >
                        {th.label}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <fieldset className="field">
                  <legend className="field-label">{t.pokemonThemeLabel}</legend>
                  <div className="segmented">
                    {pokemonThemes.map((th) => (
                      <button
                        key={th.id}
                        type="button"
                        className={`segment segment-swatch ${draft.theme === th.id ? 'is-active' : ''}`}
                        aria-pressed={draft.theme === th.id}
                        onClick={() => patch({ theme: th.id })}
                      >
                        <span
                          className="theme-swatch"
                          aria-hidden="true"
                          style={{ background: `linear-gradient(135deg, ${th.swatch[1]} 50%, ${th.swatch[0]} 50%)` }}
                        />
                        {th.label}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <fieldset className="field">
                  <legend className="field-label">{t.wallpaperLabel}</legend>
                  <div className="wallpaper-picker" role="group" aria-label={t.wallpaperLabel}>
                    <button
                      type="button"
                      className={`wallpaper-thumb ${!draftWallpaperUrl ? 'is-active' : ''}`}
                      aria-pressed={!draftWallpaperUrl}
                      title={t.wallpaperNone}
                      onClick={() => patch({ wallpaper: '' })}
                    >
                      <Ban size={18} aria-hidden="true" />
                      <span className="sr-only">{t.wallpaperNone}</span>
                    </button>
                    {WALLPAPER_PRESETS.map((preset, i) => (
                      <button
                        key={preset.id}
                        type="button"
                        className={`wallpaper-thumb ${draftWallpaperUrl === preset.url ? 'is-active' : ''}`}
                        aria-pressed={draftWallpaperUrl === preset.url}
                        aria-label={t.wallpaperPreset(i + 1)}
                        style={{ backgroundImage: `url("${preset.url}")` }}
                        onClick={() => patch({ wallpaper: presetValue(preset.id) })}
                      />
                    ))}
                    {draft.wallpaper?.startsWith('data:') && (
                      <button
                        type="button"
                        className="wallpaper-thumb is-active"
                        aria-pressed="true"
                        aria-label={t.wallpaperCustom}
                        style={{ backgroundImage: `url("${draft.wallpaper}")` }}
                      />
                    )}
                    <button
                      type="button"
                      className="wallpaper-thumb"
                      title={t.wallpaperChoose}
                      onClick={() => wallpaperInputRef.current?.click()}
                    >
                      <ImagePlus size={18} aria-hidden="true" />
                      <span className="sr-only">{t.wallpaperChoose}</span>
                    </button>
                    <input
                      ref={wallpaperInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      hidden
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        try {
                          patch({ wallpaper: await fileToWallpaper(file) });
                          setWallpaperError(false);
                        } catch {
                          setWallpaperError(true);
                        }
                      }}
                    />
                  </div>
                  {wallpaperError ? (
                    <p className="field-hint field-error" role="alert">
                      {t.wallpaperError}
                    </p>
                  ) : (
                    <p className="field-hint">{t.wallpaperHint}</p>
                  )}
                  {draftWallpaperUrl && (
                    <div className="wallpaper-sliders">
                      <label className="range-field">
                        <span>{t.wallpaperDim}</span>
                        <input
                          type="range"
                          min={0}
                          max={90}
                          value={draft.wallpaperDim ?? 55}
                          onChange={(e) => patch({ wallpaperDim: Number(e.target.value) })}
                        />
                        <output>{draft.wallpaperDim ?? 55}%</output>
                      </label>
                      <label className="range-field">
                        <span>{t.wallpaperBlur}</span>
                        <input
                          type="range"
                          min={0}
                          max={20}
                          value={draft.wallpaperBlur ?? 0}
                          onChange={(e) => patch({ wallpaperBlur: Number(e.target.value) })}
                        />
                        <output>{draft.wallpaperBlur ?? 0}px</output>
                      </label>
                    </div>
                  )}
                </fieldset>

                <div className="field">
                  <label htmlFor="set-lang" className="field-label">
                    {t.languageLabel}
                  </label>
                  <select
                    id="set-lang"
                    className="input input-narrow"
                    value={draft.language}
                    onChange={(e) => patch({ language: e.target.value as 'th' | 'en' })}
                  >
                    <option value="th">ภาษาไทย</option>
                    <option value="en">English</option>
                  </select>
                </div>

                <div className="toggle-card">
                  <div>
                    <div className="field-label" id="notify-label">
                      {t.notificationsLabel}
                    </div>
                    <p className="field-hint">{t.notificationsDesc}</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={draft.notifications !== false}
                    aria-labelledby="notify-label"
                    className={`switch ${draft.notifications !== false ? 'is-on' : ''}`}
                    onClick={() => patch({ notifications: draft.notifications === false })}
                  >
                    <span className="switch-thumb" />
                  </button>
                </div>

                <div className="field">
                  <label htmlFor="set-ws" className="field-label">
                    {t.workspaceLabel}
                  </label>
                  <div className="field-row">
                    <input
                      id="set-ws"
                      className="input input-mono"
                      value={draft.cwd}
                      onChange={(e) => patch({ cwd: e.target.value })}
                    />
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={async () => {
                        const selected = await tauriBridge.selectFolder();
                        if (selected) patch({ cwd: selected });
                      }}
                    >
                      {t.browseFolderBtn}
                    </button>
                  </div>
                  <p className="field-hint">{t.workspaceHint}</p>
                </div>

                <div className="field">
                  <label htmlFor="set-model" className="field-label">
                    {t.defaultModelLabel}
                  </label>
                  <select
                    id="set-model"
                    className="input"
                    value={modelOptionValue(draft.provider, draft.model)}
                    onChange={(e) => {
                      const { provider, model } = parseModelOptionValue(e.target.value);
                      patch({ provider, model, reasoningEffort: findModel(provider, model)?.defaultEffort ?? 'medium' });
                    }}
                  >
                    <ModelOptions settings={draft} />
                  </select>
                </div>
              </>
            )}

            {tab === 'keys' && (
              <>
                <p className="field-hint">{t.apiKeysIntro}</p>
                {PROVIDERS_CATALOG.filter((p) => p.id !== 'custom').map((p) => (
                  <div key={p.id} className="field">
                    <label htmlFor={`key-${p.id}`} className="field-label">
                      {p.name}
                    </label>
                    <input
                      id={`key-${p.id}`}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      className="input input-mono"
                      placeholder={t.apiKeyPlaceholder(p.badge)}
                      value={draft.apiKeys[p.id] ?? ''}
                      onChange={(e) => setKey(p.id, e.target.value)}
                    />
                  </div>
                ))}

                <fieldset className="field custom-endpoint">
                  <legend className="field-label">{t.customEndpointTitle}</legend>
                  <p className="field-hint">{t.customEndpointHint}</p>
                  <label htmlFor="custom-url" className="field-sublabel">
                    Base URL
                  </label>
                  <input
                    id="custom-url"
                    className="input input-mono"
                    spellCheck={false}
                    placeholder="http://localhost:11434/v1"
                    value={draft.customBaseUrl ?? ''}
                    onChange={(e) => patch({ customBaseUrl: e.target.value })}
                  />
                  <label htmlFor="custom-models" className="field-sublabel">
                    {t.customModelsLabel}
                  </label>
                  <input
                    id="custom-models"
                    className="input input-mono"
                    spellCheck={false}
                    placeholder="llama3.3, qwen3:32b"
                    value={draft.customModels ?? ''}
                    onChange={(e) => patch({ customModels: e.target.value })}
                  />
                  <label htmlFor="key-custom" className="field-sublabel">
                    {t.customKeyLabel}
                  </label>
                  <input
                    id="key-custom"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    className="input input-mono"
                    value={draft.apiKeys.custom ?? ''}
                    onChange={(e) => setKey('custom', e.target.value)}
                  />
                </fieldset>

                <fieldset className="field custom-endpoint">
                  <legend className="field-label">{t.webSearchTitle}</legend>
                  <p className="field-hint">{t.webSearchHint}</p>
                  <label htmlFor="search-provider" className="field-sublabel">
                    {t.webSearchProviderLabel}
                  </label>
                  <select
                    id="search-provider"
                    className="input"
                    value={searchProvider}
                    onChange={(e) => {
                      setSearchKey('');
                      patch({ webSearchProvider: e.target.value as AppSettings['webSearchProvider'] });
                    }}
                  >
                    <option value="off">{t.webSearchOff}</option>
                    <option value="brave">Brave Search</option>
                    <option value="tavily">Tavily</option>
                  </select>
                  {searchProvider !== 'off' && (
                    <>
                      <label htmlFor="search-key" className="field-sublabel">
                        {t.webSearchKeyLabel(searchProvider === 'brave' ? 'Brave' : 'Tavily')}
                      </label>
                      <input
                        id="search-key"
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        className="input input-mono"
                        placeholder={searchKeyStatus[searchProvider] ? t.webSearchKeySaved : t.webSearchKeyMissing}
                        value={searchKey}
                        onChange={(e) => setSearchKey(e.target.value)}
                      />
                      {searchKeyStatus[searchProvider] && !searchKey && (
                        <button type="button" className="btn btn-secondary btn-sm" onClick={removeSearchKey}>
                          {t.webSearchKeyRemove}
                        </button>
                      )}
                    </>
                  )}
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={draft.claudeWebSearch === true}
                      onChange={(e) => patch({ claudeWebSearch: e.target.checked })}
                    />
                    <span>{t.claudeWebSearchLabel}</span>
                  </label>
                  <p className="field-hint">{t.claudeWebSearchHint}</p>
                </fieldset>
              </>
            )}

            {tab === 'memory' && (
              <>
                <p className="field-hint">{t.memoryIntro}</p>
                {(
                  [
                    { id: 'user', label: t.memoryUserLabel, hint: t.memoryUserHint, draft: userMemory, set: setUserMemory },
                    { id: 'project', label: t.memoryProjectLabel, hint: t.memoryProjectHint, draft: projectMemory, set: setProjectMemory },
                  ] as const
                ).map(({ id, label, hint, draft: mem, set }) => (
                  <div key={id} className="field">
                    <label htmlFor={`memory-${id}`} className="field-label">
                      {label}
                    </label>
                    <p className="field-hint">{hint}</p>
                    {id === 'project' && !settings.cwd ? (
                      <p className="field-hint">{t.memoryNoWorkspace}</p>
                    ) : (
                      <>
                        <textarea
                          id={`memory-${id}`}
                          className="input input-mono memory-input"
                          spellCheck={false}
                          rows={8}
                          placeholder={t.memoryEmpty}
                          value={mem.value}
                          onChange={(e) => set({ ...mem, value: e.target.value })}
                        />
                        <p className={`field-hint ${mem.value.length > MEMORY_MAX_CHARS ? 'is-error' : ''}`}>
                          {t.memoryCount(mem.value.length, MEMORY_MAX_CHARS)}
                          {mem.path ? ` · ${mem.path}` : ''}
                        </p>
                      </>
                    )}
                  </div>
                ))}
              </>
            )}

            {tab === 'permissions' && (
              <>
                <div className="toggle-card">
                  <div>
                    <div className="field-label" id="autopilot-label">
                      {t.autoPilotLabel}
                    </div>
                    <p className="field-hint">{t.autoPilotDesc}</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={draft.autoPilot}
                    aria-labelledby="autopilot-label"
                    className={`switch ${draft.autoPilot ? 'is-on' : ''}`}
                    onClick={() => patch({ autoPilot: !draft.autoPilot })}
                  >
                    <span className="switch-thumb" />
                  </button>
                </div>
                <p className="field-hint">{t.securityNote}</p>
                <p className="field-hint">{t.sensitiveNote}</p>
                <PermissionRulesEditor
                  rules={draft.permissionRules ?? []}
                  onChange={(permissionRules) => patch({ permissionRules })}
                  t={t}
                />
              </>
            )}

            {tab === 'extensions' && (
              <>
                <SkillsSettings
                  cwd={draft.cwd}
                  disabled={draft.disabledSkills ?? []}
                  onChangeDisabled={(disabledSkills) => patch({ disabledSkills })}
                  t={t}
                />
                <McpSettings value={draft.mcpConfig ?? ''} onChange={(mcpConfig) => patch({ mcpConfig })} t={t} />
              </>
            )}
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              {t.cancelBtn}
            </button>
            <button type="button" className="btn btn-primary" onClick={handleSave}>
              {saved ? t.savedBtn : t.saveBtn}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};
