import React, { useState, useEffect, useRef } from 'react';
import { X, KeyRound, SlidersHorizontal, ShieldCheck } from 'lucide-react';
import type { AppSettings, AIProvider, PokemonTheme, ThemePreference } from '../types/agent';
import { PROVIDERS_CATALOG, findModel } from '../types/agent';
import { tauriBridge } from '../services/tauriBridge';
import { translations } from '../utils/i18n';
import { PermissionRulesEditor } from './PermissionRulesEditor';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSave: (newSettings: AppSettings) => void;
}

type Tab = 'general' | 'keys' | 'permissions';

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, settings, onSave }) => {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [tab, setTab] = useState<Tab>('general');
  const [saved, setSaved] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // รีเซ็ตฟอร์มเมื่อเปิดใหม่เท่านั้น (เดิมรีเซ็ตทุกครั้งที่ settings เปลี่ยน ทำให้สิ่งที่พิมพ์ค้างหาย)
  useEffect(() => {
    if (isOpen) {
      setDraft(settings);
      setSaved(false);
    }
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
  const activeKeys = Object.values(draft.apiKeys).filter((k) => k.trim()).length;

  const handleSave = () => {
    onSave({
      ...draft,
      cwd: draft.cwd.trim(),
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
                    value={`${draft.provider}::${draft.model}`}
                    onChange={(e) => {
                      const [provider, model] = e.target.value.split('::') as [AIProvider, string];
                      patch({ provider, model, reasoningEffort: findModel(provider, model)?.defaultEffort ?? 'medium' });
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
              </>
            )}

            {tab === 'keys' && (
              <>
                <p className="field-hint">{t.apiKeysIntro}</p>
                {PROVIDERS_CATALOG.map((p) => (
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
