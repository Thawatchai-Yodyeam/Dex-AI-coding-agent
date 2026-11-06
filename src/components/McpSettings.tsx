import React, { useMemo } from 'react';
import { Plug, RotateCcw } from 'lucide-react';
import { useMcpStatuses } from '../hooks/useMcpStatuses';
import { MCP_CONFIG_EXAMPLE, parseMcpConfig } from '../services/mcp/config';
import { mcpManager } from '../services/mcp/manager';
import { describeOauthError, mcpStatusLabel } from '../services/mcp/oauth';
import type { Translation } from '../utils/i18n';
import { McpSignInButton } from './McpSignInButton';

interface McpSettingsProps {
  /** JSON ในฟอร์ม (ยังไม่บันทึก) */
  value: string;
  onChange: (value: string) => void;
  t: Translation;
}

/** แก้ config ของ MCP server (JSON แบบ Claude Desktop) และดูสถานะการเชื่อมต่อจริง */
export const McpSettings: React.FC<McpSettingsProps> = ({ value, onChange, t }) => {
  const statuses = useMcpStatuses();
  const parsed = useMemo(() => parseMcpConfig(value), [value]);

  return (
    <section className="field">
      <h3 className="field-label">MCP servers</h3>
      <p className="field-hint">{t.mcpIntro}</p>
      <label htmlFor="mcp-config" className="sr-only">
        MCP config (JSON)
      </label>
      <textarea
        id="mcp-config"
        className="input mcp-config"
        spellCheck={false}
        placeholder={MCP_CONFIG_EXAMPLE}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {parsed.errors.length > 0 ? (
        <ul className="field-hint mcp-errors" role="alert">
          {parsed.errors.map((err) => (
            <li key={err}>{err}</li>
          ))}
        </ul>
      ) : (
        parsed.servers.length > 0 && <p className="field-hint">{t.mcpSaveHint(parsed.servers.length)}</p>
      )}

      {statuses.length > 0 && (
        <ul className="ext-list">
          {statuses.map((s) => (
            <li key={s.key} className="ext-item">
              <Plug size={15} aria-hidden="true" />
              <div className="ext-item-text">
                <div className="ext-item-name">
                  <code>{s.name}</code>
                  <span className="tool-tag">{s.transport}</span>
                  <span className={`ext-status is-${s.state}`}>{mcpStatusLabel(s, t)}</span>
                </div>
                {s.state === 'ready' && s.tools.length > 0 && <p className="field-hint">{s.tools.join(', ')}</p>}
                {s.error && <pre className="tool-error mcp-error">{describeOauthError(s.error, t)}</pre>}
                <McpSignInButton status={s} t={t} />
              </div>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                onClick={() => mcpManager.restart(s.key)}
                aria-label={`${t.mcpRestart}: ${s.name}`}
                title={t.mcpRestart}
              >
                <RotateCcw size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
