import React, { useEffect, useRef, useState } from 'react';
import { LogIn } from 'lucide-react';
import { mcpManager, type McpServerStatus } from '../services/mcp/manager';
import { describeOauthError, isOauthCancelled, signInToMcpServer } from '../services/mcp/oauth';
import { tauriBridge } from '../services/tauriBridge';
import type { Translation } from '../utils/i18n';

/** ปุ่มล็อกอินในรายการ server: แสดงเมื่อ server ขอให้ล็อกอินหรือขอสิทธิ์เพิ่ม — ล็อกอินเสร็จแล้วเชื่อมต่อใหม่ให้ */
export const McpSignInButton: React.FC<{ status: McpServerStatus; t: Translation }> = ({ status, t }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);

  useEffect(
    () => () => {
      if (pending.current) void tauriBridge.mcpOauthCancel(status.key).catch(() => {});
    },
    [status.key]
  );

  if (!status.oauthUrl || (status.state !== 'auth' && !status.needsMoreScope)) return null;
  const url = status.oauthUrl;

  const signIn = async () => {
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await signInToMcpServer(status.key, url, t, status.requiredScope);
      mcpManager.restart(status.key);
    } catch (err) {
      if (!isOauthCancelled(err)) setError(describeOauthError(err, t));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="mcp-signin">
      {busy ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void tauriBridge.mcpOauthCancel(status.key).catch(() => {})}>
          {t.oauthCancel}
        </button>
      ) : (
        <button type="button" className="btn btn-secondary btn-sm" onClick={signIn}>
          <LogIn size={14} aria-hidden="true" />
          {status.needsMoreScope ? t.oauthSignInAgain : t.oauthSignIn}
        </button>
      )}
      {busy && (
        <span className="field-hint" role="status">
          {t.oauthWaiting}
        </span>
      )}
      {status.needsMoreScope && !busy && <span className="field-hint">{t.oauthMoreScope}</span>}
      {error && (
        <p className="plugin-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};
