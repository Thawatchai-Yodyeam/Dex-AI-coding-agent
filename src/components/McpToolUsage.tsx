import React from 'react';
import type { McpServerStatus } from '../services/mcp/manager';
import type { ToolUsageSummary } from '../services/mcp/toolUsage';
import type { Translation } from '../utils/i18n';
import { formatTokens } from './TokenUsageChip';

export const EnableSwitch: React.FC<{ label: string; enabled: boolean; onChange: (enabled: boolean) => void }> = ({ label, enabled, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={enabled}
    aria-label={label}
    className={`switch ${enabled ? 'is-on' : ''}`}
    onClick={() => onChange(!enabled)}
  >
    <span className="switch-thumb" />
  </button>
);

/** ยอดรวมของ tool ที่ส่งให้โมเดล พร้อมคำเตือนเมื่อสูงจนมีผลกับค่าใช้จ่ายหรือเกินเพดานของค่ายที่เลือกอยู่ */
export const McpUsageSummary: React.FC<{
  usage: ToolUsageSummary;
  /** เพดานของค่ายที่เลือกอยู่ (null = เอกสารไม่ระบุ) */
  limit: number | null;
  providerName: string;
  t: Translation;
}> = ({ usage, limit, providerName, t }) => {
  const overLimit = limit !== null && usage.totalTools > limit;
  return (
    <section className="tool-usage" aria-labelledby="tool-usage-title">
      <h2 id="tool-usage-title" className="tool-usage-title">
        {t.toolUsageTitle}
      </h2>
      <dl className="tool-usage-stats">
        <div>
          <dt>{t.toolUsageFromPlugins}</dt>
          <dd>{t.toolUsageStat(usage.mcpTools, formatTokens(usage.mcpTokens))}</dd>
        </div>
        <div>
          <dt>{t.toolUsageBuiltIn}</dt>
          <dd>{t.toolUsageStat(usage.builtInTools, formatTokens(usage.builtInTokens))}</dd>
        </div>
        <div>
          <dt>{t.toolUsageTotal}</dt>
          <dd>{t.toolUsageStat(usage.totalTools, formatTokens(usage.totalTokens))}</dd>
        </div>
      </dl>
      <p className="field-hint">{t.toolUsageHint}</p>
      {overLimit && (
        <p className="custom-notice is-danger tool-usage-notice" role="alert">
          {t.toolUsageOverLimit(providerName, limit, usage.totalTools)}
        </p>
      )}
      {usage.isHigh && (
        <p className="custom-notice is-warning tool-usage-notice" role="status">
          {t.toolUsageHigh(usage.totalTools, formatTokens(usage.mcpTokens))}
        </p>
      )}
    </section>
  );
};

/** tool ของ server หนึ่งตัว: ขนาดรวม และเปิด/ปิดรายตัว — เรียงตัวใหญ่ก่อนเพื่อให้เห็นว่าปิดตัวไหนแล้วคุ้ม */
export const McpToolList: React.FC<{
  status: McpServerStatus;
  /** ชื่อที่แสดงให้ผู้ใช้เห็น */
  serverLabel: string;
  t: Translation;
  onSetDisabled: (tools: string[], disabled: boolean) => void;
}> = ({ status, serverLabel, t, onSetDisabled }) => {
  const enabled = status.toolInfo.filter((tool) => tool.enabled);
  const tokens = enabled.reduce((sum, tool) => sum + tool.tokens, 0);
  const allNames = status.toolInfo.map((tool) => tool.name);
  const largestFirst = [...status.toolInfo].sort((a, b) => b.tokens - a.tokens);
  return (
    <details className="mcp-tools">
      <summary>{t.toolUsageServer(enabled.length, status.toolInfo.length, formatTokens(tokens))}</summary>
      <div className="mcp-tools-actions">
        <button type="button" className="btn btn-ghost btn-sm" disabled={enabled.length === allNames.length} onClick={() => onSetDisabled(allNames, false)}>
          {t.toolUsageEnableAll}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={enabled.length === 0} onClick={() => onSetDisabled(allNames, true)}>
          {t.toolUsageDisableAll}
        </button>
      </div>
      <ul className="mcp-tool-list" aria-label={t.toolUsageToolList(serverLabel)}>
        {largestFirst.map((tool) => (
          <li key={tool.name} className={`mcp-tool ${tool.enabled ? '' : 'is-off'}`}>
            <div className="mcp-tool-text">
              <div className="mcp-tool-name">
                <code>{tool.name}</code>
                <span className="mcp-tool-size">~{formatTokens(tool.tokens)}</span>
              </div>
              {tool.description && (
                <p className="field-hint mcp-tool-desc" title={tool.description}>
                  {tool.description}
                </p>
              )}
            </div>
            <EnableSwitch label={tool.name} enabled={tool.enabled} onChange={(on) => onSetDisabled([tool.name], !on)} />
          </li>
        ))}
      </ul>
    </details>
  );
};
