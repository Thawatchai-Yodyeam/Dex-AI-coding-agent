import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { loadSkills, SKILL_ROOTS_HINT } from '../services/agent/skills';
import type { SkillInfo } from '../services/tauriBridge';
import type { Translation } from '../utils/i18n';

interface SkillsSettingsProps {
  cwd: string;
  disabled: string[];
  onChangeDisabled: (names: string[]) => void;
  t: Translation;
}

/** รายการ skill ที่ค้นเจอใน workspace / โฟลเดอร์ผู้ใช้ พร้อมสวิตช์เปิด-ปิดทีละตัว */
export const SkillsSettings: React.FC<SkillsSettingsProps> = ({ cwd, disabled, onChangeDisabled, t }) => {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);

  const refresh = useCallback(() => {
    setSkills(null);
    void loadSkills(cwd).then(setSkills);
  }, [cwd]);

  useEffect(refresh, [refresh]);

  const off = new Set(disabled.map((d) => d.toLowerCase()));
  const toggle = (name: string) => {
    const key = name.toLowerCase();
    onChangeDisabled(off.has(key) ? disabled.filter((d) => d.toLowerCase() !== key) : [...disabled, name]);
  };

  return (
    <section className="field">
      <div className="field-row field-row-between">
        <h3 className="field-label">{t.skillsTitle}</h3>
        <button type="button" className="btn btn-ghost btn-sm" onClick={refresh}>
          <RefreshCw size={14} aria-hidden="true" />
          {t.refreshSkills}
        </button>
      </div>
      <p className="field-hint">
        {t.skillsIntro} <code>{SKILL_ROOTS_HINT}</code>
      </p>
      {skills === null ? (
        <p className="field-hint">{t.loadingFiles}</p>
      ) : skills.length === 0 ? (
        <p className="field-hint">{t.skillsEmpty}</p>
      ) : (
        <ul className="ext-list">
          {skills.map((skill) => {
            const enabled = !off.has(skill.name.toLowerCase());
            return (
              <li key={skill.dir} className="ext-item" title={skill.dir}>
                <Sparkles size={15} aria-hidden="true" />
                <div className="ext-item-text">
                  <div className="ext-item-name">
                    <code>/{skill.name}</code>
                    <span className="tool-tag">{skill.source === 'workspace' ? t.skillSourceWorkspace : t.skillSourceUser}</span>
                  </div>
                  <p className="field-hint">{skill.description}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  aria-label={skill.name}
                  className={`switch ${enabled ? 'is-on' : ''}`}
                  onClick={() => toggle(skill.name)}
                >
                  <span className="switch-thumb" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
