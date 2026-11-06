import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink, LogIn, LogOut, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { McpServerStatus } from '../services/mcp/manager';
import { describeOauthError, isOauthCancelled, issuerHost, mcpStatusLabel, signInToMcpServer } from '../services/mcp/oauth';
import type { MarketplacePlugin } from '../services/marketplace/catalog';
import { pluginRuntime, pluginTarget, usesOauth, type PluginState } from '../services/marketplace/plugins';
import { tauriBridge, type McpOauthStatus } from '../services/tauriBridge';
import type { AppLanguage, Translation } from '../utils/i18n';
import { PluginIcon } from './PluginIcon';

interface PluginDialogProps {
  plugin: MarketplacePlugin;
  state: PluginState;
  /** สถานะการเชื่อมต่อจริง (เฉพาะ MCP ที่เปิดอยู่) */
  status?: McpServerStatus;
  uninstallable: boolean;
  /** ติดตั้งไว้ตั้งแต่รุ่นที่ใช้คีย์ และ config ยังเป็นแบบเดิม */
  legacyAuth: boolean;
  /** ของที่ติดตั้งไว้ไม่ตรงกับ catalog */
  hasUpdate: boolean;
  /** คำสั่งหรือ URL ที่ติดตั้งอยู่ตอนนี้ (null = ไม่ต้องแสดง เช่น skill) */
  currentTarget: string | null;
  language: AppLanguage;
  t: Translation;
  /** signIn = ต้องล็อกอินก่อนเพิ่มลง config */
  onInstall: (values: Record<string, string>, signIn?: () => Promise<void>) => Promise<void>;
  /** signIn = ต้องล็อกอินก่อนเปลี่ยน config (ย้ายจากคีย์มาล็อกอิน) */
  onUpdate: (values: Record<string, string>, signIn?: () => Promise<void>) => Promise<void>;
  onSignedIn: () => Promise<void>;
  onSignedOut: () => void;
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
  legacyAuth,
  hasUpdate,
  currentTarget,
  language,
  t,
  onInstall,
  onUpdate,
  onSignedIn,
  onSignedOut,
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
  const [oauth, setOauth] = useState<McpOauthStatus | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const signingInRef = useRef(false);
  const [runtimeFound, setRuntimeFound] = useState(true);
  const dialogRef = useRef<HTMLDivElement>(null);

  const secrets = plugin.secrets ?? [];
  const installed = state !== 'available';
  const runtime = pluginRuntime(plugin);
  const runtimeCommand = runtime?.command;
  const isRemote = plugin.install.kind === 'mcp' && typeof plugin.install.server.url === 'string';
  const hasTypedKeys = secrets.some((s) => values[s.name]?.trim());
  const missingKey = secrets.some((s) => !present[s.name] && !values[s.name]?.trim());
  const isOauth = usesOauth(plugin);
  const oauthUrl = isOauth && plugin.install.kind === 'mcp' ? String(plugin.install.server.url) : '';
  const signedIn = oauth?.signed_in === true;
  const signedInHost = issuerHost(oauth?.issuer ?? null);

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

  const refreshOauth = React.useCallback(() => {
    if (!oauthUrl) return;
    tauriBridge
      .mcpOauthStatus(plugin.id, oauthUrl)
      .then(setOauth)
      .catch(() => setOauth(null));
  }, [plugin.id, oauthUrl]);
  // อ่านใหม่ทุกครั้งที่สถานะการเชื่อมต่อเปลี่ยน — refresh token ใช้ไม่ได้แล้วฝั่ง Rust จะลบ token ทิ้งระหว่างเชื่อมต่อ
  useEffect(refreshOauth, [refreshOauth, status?.state]);

  // ปิด dialog ระหว่างรอ: หยุดรอและคืนพอร์ต ไม่งั้นล็อกอินสำเร็จแล้วจะไม่มีใครเปิด server ใหม่ให้
  useEffect(
    () => () => {
      if (signingInRef.current) void tauriBridge.mcpOauthCancel(plugin.id).catch(() => {});
    },
    [plugin.id]
  );

  useEffect(() => {
    if (!runtimeCommand) return;
    // เช็กไม่ได้ (รันนอก Tauri) ก็ไม่บล็อก — ถ้าขาดจริง สถานะ error ของ server ยังบอกสาเหตุได้
    tauriBridge
      .commandAvailable(runtimeCommand)
      .then(setRuntimeFound)
      .catch(() => setRuntimeFound(true));
  }, [runtimeCommand]);

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
    } catch (err) {
      // ผู้ใช้กดยกเลิกเอง ไม่ใช่ข้อผิดพลาด
      if (!isOauthCancelled(err)) setError(describeOauthError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const signIn = async () => {
    signingInRef.current = true;
    setSigningIn(true);
    try {
      setOauth(await signInToMcpServer(plugin.id, oauthUrl, t, status?.requiredScope));
    } finally {
      signingInRef.current = false;
      setSigningIn(false);
    }
  };

  const handleInstall = () =>
    run(async () => {
      await onInstall(values, isOauth && !signedIn ? signIn : undefined);
      setValues({});
      refreshPresent();
    });

  const handleSignIn = () =>
    run(async () => {
      await signIn();
      await onSignedIn();
    });

  const handleSignOut = () =>
    run(async () => {
      await tauriBridge.mcpOauthLogout(plugin.id);
      refreshOauth();
      onSignedOut();
    });

  const handleUpdate = () =>
    run(async () => {
      await onUpdate(values, isOauth && !signedIn ? signIn : undefined);
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
              {status && <span className={`ext-status is-${status.state}`}>{mcpStatusLabel(status, t)}</span>}
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
              <pre className="tool-error mcp-error">{describeOauthError(status.error, t)}</pre>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onRestart}>
                <RotateCcw size={14} aria-hidden="true" />
                {t.mcpRestart}
              </button>
            </div>
          )}

          {hasUpdate && (
            <section className="plugin-update">
              <h3 className="plugin-target-title">{t.pluginUpdateTitle}</h3>
              {currentTarget && (
                <>
                  <p className="field-hint">{t.pluginUpdateCurrent}</p>
                  <code className="plugin-target-code">{currentTarget}</code>
                </>
              )}
              <p className="field-hint">{plugin.install.kind === 'skill' ? t.pluginUpdateSkillHint : t.pluginUpdateHint}</p>
            </section>
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
              {runtime &&
                (runtimeFound ? (
                  <li>{t.pluginRuntimeFound(runtime.name)}</li>
                ) : (
                  <li className="is-missing" role="alert">
                    {t.pluginRuntimeMissing(runtime.name)}{' '}
                    <a href={runtime.url} onClick={(e) => openExternal(e, runtime.url)}>
                      {t.pluginGetRuntime}
                    </a>
                  </li>
                ))}
              {plugin.note && <li>{plugin.note[language]}</li>}
            </ul>
          )}

          {isOauth && (
            <section className="plugin-oauth">
              <h3 className="plugin-target-title">{t.oauthTitle}</h3>
              <p className="field-hint">{installed ? t.oauthHint : t.oauthInstallHint}</p>
              {legacyAuth && <p className="field-hint">{t.oauthMigrate}</p>}
              {status?.needsMoreScope && <p className="field-hint">{t.oauthMoreScope}</p>}
              <div className="plugin-oauth-row">
                <span className={`ext-status ${signingIn ? 'is-starting' : signedIn ? 'is-ready' : 'is-auth'}`} role="status">
                  {signingIn
                    ? t.oauthWaiting
                    : signedIn
                      ? signedInHost
                        ? t.oauthSignedInWith(signedInHost)
                        : t.oauthSignedIn
                      : t.oauthNotSignedIn}
                </span>
                <div className="plugin-oauth-actions">
                  {signingIn ? (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void tauriBridge.mcpOauthCancel(plugin.id).catch(() => {})}>
                      {t.oauthCancel}
                    </button>
                  ) : (
                    installed && (
                      <>
                        {signedIn && (
                          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={handleSignOut}>
                            <LogOut size={14} aria-hidden="true" />
                            {t.oauthSignOut}
                          </button>
                        )}
                        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={handleSignIn}>
                          <LogIn size={14} aria-hidden="true" />
                          {signedIn ? t.oauthSignInAgain : t.oauthSignIn}
                        </button>
                      </>
                    )
                  )}
                </div>
              </div>
              {signedIn && oauth?.scope && <p className="field-hint plugin-oauth-scope">{t.oauthScope(oauth.scope)}</p>}
              {signedIn && <p className="field-hint">{t.oauthSignOutHint}</p>}
            </section>
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
            <button type="button" className="btn btn-primary" disabled={busy || missingKey || !runtimeFound} onClick={handleInstall}>
              <Plus size={16} aria-hidden="true" />
              {signingIn ? t.oauthWaiting : busy ? t.pluginInstalling : isOauth && !signedIn ? t.oauthInstallAndSignIn : t.pluginInstall}
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
              {/* ตอนมีอัปเดต ปุ่มอัปเดตเก็บคีย์ที่กรอกให้ด้วย ถ้ามีปุ่มนี้อีกจะเปิด server เวอร์ชันเก่าใหม่โดยเปล่าประโยชน์ */}
              {hasTypedKeys && !hasUpdate && (
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={handleSaveKeys}>
                  {t.pluginSaveKeys}
                </button>
              )}
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onSetEnabled(state === 'disabled')}>
                {state === 'disabled' ? t.pluginEnable : t.pluginDisable}
              </button>
              {hasUpdate && (
                <button type="button" className="btn btn-primary" disabled={busy || missingKey || !runtimeFound} onClick={handleUpdate}>
                  {busy ? t.pluginUpdating : t.pluginUpdate}
                </button>
              )}
            </>
          )}
        </footer>
      </div>
    </div>
  );
};
