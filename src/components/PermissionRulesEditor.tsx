import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { PermissionRule, PermissionTool } from '../types/agent';
import { PERMISSION_TOOLS } from '../types/agent';
import { newRuleId } from '../services/agent/permissions';
import type { Translation } from '../utils/i18n';

/** รายการกฎ Allow/Deny ในแท็บสิทธิ์ — แก้ draft ของ SettingsModal (บันทึกจริงตอนกด "บันทึก") */
export const PermissionRulesEditor: React.FC<{
  rules: PermissionRule[];
  onChange: (rules: PermissionRule[]) => void;
  t: Translation;
}> = ({ rules, onChange, t }) => {
  const [action, setAction] = useState<PermissionRule['action']>('allow');
  const [tool, setTool] = useState<PermissionTool>('shell');
  const [pattern, setPattern] = useState('');

  const add = () => {
    const trimmed = pattern.trim();
    if (!trimmed) return;
    const duplicate = rules.some(
      (r) => r.action === action && r.tool === tool && r.pattern.toLowerCase() === trimmed.toLowerCase()
    );
    if (!duplicate) onChange([...rules, { id: newRuleId(), action, tool, pattern: trimmed }]);
    setPattern('');
  };

  // deny ขึ้นก่อน เพราะเป็นกฎที่ชนะ
  const sorted = [...rules].sort((a, b) => (a.action === b.action ? 0 : a.action === 'deny' ? -1 : 1));

  return (
    <fieldset className="field">
      <legend className="field-label">{t.rulesTitle}</legend>
      <p className="field-hint">{t.rulesIntro}</p>

      {sorted.length === 0 ? (
        <p className="rules-empty">{t.rulesEmpty}</p>
      ) : (
        <ul className="rules-list">
          {sorted.map((rule) => (
            <li key={rule.id} className="rule-row">
              <span className={`rule-badge is-${rule.action}`}>
                {rule.action === 'allow' ? t.ruleAllow : t.ruleDeny}
              </span>
              <span className="rule-tool">{t.ruleTools[rule.tool]}</span>
              <code className="rule-pattern">{rule.pattern}</code>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                onClick={() => onChange(rules.filter((r) => r.id !== rule.id))}
                aria-label={`${t.deleteRule}: ${rule.pattern}`}
                title={t.deleteRule}
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="rule-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <select
          className="input"
          aria-label={t.ruleActionLabel}
          value={action}
          onChange={(e) => setAction(e.target.value as PermissionRule['action'])}
        >
          <option value="allow">{t.ruleAllow}</option>
          <option value="deny">{t.ruleDeny}</option>
        </select>
        <select
          className="input"
          aria-label={t.ruleToolLabel}
          value={tool}
          onChange={(e) => setTool(e.target.value as PermissionTool)}
        >
          {PERMISSION_TOOLS.map((id) => (
            <option key={id} value={id}>
              {t.ruleTools[id]}
            </option>
          ))}
        </select>
        <input
          className="input input-mono rule-add-pattern"
          aria-label={t.rulePatternLabel}
          placeholder={t.rulePatternPlaceholder}
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          spellCheck={false}
        />
        <button type="submit" className="btn btn-secondary" disabled={!pattern.trim()}>
          <Plus size={15} aria-hidden="true" />
          {t.addRuleBtn}
        </button>
      </form>
    </fieldset>
  );
};
