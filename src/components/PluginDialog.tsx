import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { McpServerStatus } from '../services/mcp/manager';
import type { MarketplacePlugin } from '../services/marketplace/catalog';
import { pluginRuntime, pluginTarget, type PluginState } from '../services/marketplace/plugins';
import { tauriBridge } from '../services/tauriBridge';
import type { AppLanguage, Translation } from '../utils/i18n';
import { PluginIcon } from './PluginIcon';

interface PluginDialogProps {
  plugin: MarketplacePlugin;
  state: PluginState;
  /** สถานะการเชื่อมต่อจริง (เฉพาะ MCP ที่เปิดอยู่) */
  status?: McpServerStatus;
  uninstallable: boolean;
  language: AppLanguage;
  t: Translation;
  onInstall: (values: Record<string, string>) => Promise<void>;
  onUninstall: () => Promise<void>;
  onSetEnabled: (enabled: boolean) => void;
  onSaveKeys: (values: Record<string, string>) => Promise<void>;
  onRestart: () => void;
  onClose: () => void;
}

const openExternal = (e: React.MouseEvent, url: string) => {
  e.preventDefault();
  openUrl(url).catch((err) => console.warn('Could not open link:', err));
};

/**
 * รายละเอียดของ plugin ก่อนติดตั้ง: แสดงให้เห็นว่าจะรันหรือเชื่อมต่ออะไร
 * วางทับเฉพาะคอลัมน์หลัก — browser pane เป็น native webview ที่อยู่เหนือ DOM ถ้าเต็มหน้าต่างจะโดนบัง
 */
export const PluginDialog: React.FC<PluginDialogProps> = ({
  plugin,
  state,
  status,
  uninstallable,
  language,
  t,
  onInstall,
  onUninstall,
  onSetEnabled,
  onSaveKeys,
  onRestart,
  onClose,
}) => {
  const [values, setValues] = useState<Record<string, string>>({});
  const [present, setPresent] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const secrets = plugin.secrets ?? [];
  const installed = state !== 'available';
  const runtime = pluginRuntime(plugin);
  const isRemote = plugin.install.kind === 'mcp' && typeof plugin.install.server.url === 'string';
  const hasTypedKeys = secrets.some((s) => values[s.name]?.trim());
  const missingKey = secrets.some((s) => !present[s.name] && !values[s.name]?.trim());

  const refreshPresent = React.useCallback(() => {
    if (secrets.length === 0) return;
    tauriBridge
      .mcpSecretsPresent(secrets.map((s) => s.name))
      .then(setPresent)
      .catch(() => setPresent({}));
    // รายการคีย์ของ plugin เดิมไม่เปลี่ยนระหว่างที่ dialog เปิดอยู่
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin.id]);
  useEffect(refreshPresent, [refreshPresent]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleInstall = () =>
    run(async () => {
      await onInstall(values);
      setValues({});
      refreshPresent();
    });

  const handleSaveKeys = () =>
    run(async () => {
      await onSaveKeys(values);
      setValues({});
      refreshPresent();
    });

  const handleUninstall = () => {
    if (!confirmUninstall) {
      setConfirmUninstall(true);
      setTimeout(() => setConfirmUninstall(false), 3500);
      return;
    }
    void run(onUninstall);
  };

  return (
    <div className="plugin-dialog-overlay" onMouseDown={onClose}>
      <div
        className="plugin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-dialog-title"
        tabIndex={-1}
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="plugin-dialog-head">
          <PluginIcon plugin={plugin} />
          <div className="plugin-dialog-heading">
            <h2 id="plugin-dialog-title" className="plugin-dialog-title">
              {plugin.name}
            </h2>
            <div className="plugin-dialog-meta">
              <span>{t.pluginBy(plugin.publisher)}</span>
              {plugin.community && <span className="tool-tag">{t.pluginCommunity}</span>}
              {state === 'disabled' && <span className="plugin-badge">{t.pluginDisabled}</span>}
              {status && (
                <span className={`ext-status is-${status.state}`}>
                  {status.state === 'ready' ? t.mcpReady(status.tools.length) : status.state === 'starting' ? t.mcpStarting : t.mcpError}
                </span>
              )}
              {state === 'enabled' && plugin.install.kind === 'skill' && <span className="ext-status is-ready">{t.pluginInstalled}</span>}
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t.pluginClose} title={t.pluginClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="plugin-dialog-body">
          <p className="plugin-dialog-desc">{plugin.description[language]}</p>

          {status?.error && (
            <div>
              <pre className="tool-error mcp-error">{status.error}</pre>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onRestart}>
                <RotateCcw size={14} aria-hidden="true" />
                {t.mcpRestart}
              </button>
            </div>
          )}

          <section className="plugin-target">
            <h3 className="plugin-target-title">
              {plugin.install.kind === 'skill' ? t.pluginAddsSkill : isRemote ? t.pluginConnectsTo : t.pluginRunsCommand}
            </h3>
            <code className="plugin-target-code">{pluginTarget(plugin)}</code>
            <p className="field-hint">
              {plugin.install.kind === 'skill' ? t.pluginSkillHint : isRemote ? t.pluginRemoteHint : t.pluginLocalHint}
            </p>
            {plugin.install.kind === 'skill' && (
              <details className="plugin-skill-preview">
                <summary>{t.pluginViewInstructions}</summary>
                <pre>{plugin.install.instructions.trim()}</pre>
              </details>
            )}
          </section>

          {(runtime || plugin.note) && (
            <ul className="plugin-requirements">
              {runtime && (
                <li>
                  {t.pluginNeedsRuntime(runtime.name)}{' '}
                  <a href={runtime.url} onClick={(e) => openExternal(e, runtime.url)}>
                    {t.pluginGetRuntime}
                  </a>
                </li>
              )}
              {plugin.note && <li>{plugin.note[language]}</li>}
            </ul>
          )}

          {secrets.length > 0 && (
            <section className="plugin-secrets">
              <h3 className="plugin-target-title">{t.pluginKeysTitle}</h3>
              <p className="field-hint">{t.pluginKeysHint}</p>
              {secrets.map((secret) => (
                <div key={secret.name} className="plugin-secret">
                  <div className="plugin-secret-label">
                    <label htmlFor={`secret-${secret.name}`}>{secret.label}</label>
                    <a href={secret.helpUrl} onClick={(e) => openExternal(e, secret.helpUrl)}>
                      {t.pluginGetKey}
                    </a>
                  </div>
                  <input
                    id={`secret-${secret.name}`}
                    className="input input-mono"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={present[secret.name] ? t.pluginKeySet : secret.name}
                    value={values[secret.name] ?? ''}
                    onChange={(e) => setValues((prev) => ({ ...prev, [secret.name]: e.target.value }))}
                  />
                </div>
              ))}
            </section>
          )}

          <a className="plugin-homepage" href={plugin.homepage} onClick={(e) => openExternal(e, plugin.homepage)}>
            <ExternalLink size={13} aria-hidden="true" />
            {t.pluginHomepage}
          </a>

          {error && (
            <p className="plugin-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className="plugin-dialog-foot">
          {!installed ? (
            <button type="button" className="btn btn-primary" disabled={busy || missingKey} onClick={handleInstall}>
              <Plus size={16} aria-hidden="true" />
              {busy ? t.pluginInstalling : t.pluginInstall}
            </button>
          ) : (
            <>
              {uninstallable ? (
                <button
                  type="button"
                  className={`btn btn-ghost plugin-uninstall ${confirmUninstall ? 'is-danger' : ''}`}
                  disabled={busy}
                  onClick={handleUninstall}
                >
                  <Trash2 size={15} aria-hidden="true" />
                  {confirmUninstall ? t.pluginConfirmUninstall : t.pluginUninstall}
                </button>
              ) : (
                <p className="field-hint plugin-foot-note">{t.pluginNotManaged}</p>
              )}
              {hasTypedKeys && (
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={handleSaveKeys}>
                  {t.pluginSaveKeys}
                </button>
              )}
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onSetEnabled(state === 'disabled')}>
                {state === 'disabled' ? t.pluginEnable : t.pluginDisable}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
};
