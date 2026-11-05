import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Plug, Plus, RotateCcw, Search, Settings2, Sparkles, Trash2 } from 'lucide-react';
import { useMcpStatuses } from '../hooks/useMcpStatuses';
import { loadSkills } from '../services/agent/skills';
import { isMcpEntryDisabled, readMcpEntries, withMcpEntry, withMcpEntryDisabled } from '../services/mcp/config';
import { mcpManager, type McpServerStatus } from '../services/mcp/manager';
import { MARKETPLACE_PLUGINS, PLUGIN_SECTIONS, type MarketplacePlugin } from '../services/marketplace/catalog';
import {
  canUninstall,
  customMcpNames,
  customSkills,
  enabledPatch,
  installPatch,
  matchesQuery,
  pluginState,
  prepareInstall,
  prepareUninstall,
  saveSecrets,
  uninstallPatch,
  type PluginSettings,
} from '../services/marketplace/plugins';
import type { SkillInfo } from '../services/tauriBridge';
import type { AppSettings } from '../types/agent';
import type { Translation } from '../utils/i18n';
import { PluginDialog } from './PluginDialog';
import { PluginIcon, PluginTile } from './PluginIcon';

interface CustomizationsPageProps {
  settings: AppSettings;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
  t: Translation;
  agentRunning: boolean;
  onBackToChat: () => void;
  /** เปิดหน้าตั้งค่าไปที่แท็บ Skills และ MCP */
  onEditConfig: () => void;
}

type Tab = 'marketplace' | 'installed';

/** จำนวนที่แสดงก่อนกด "ดูเพิ่ม" */
const SECTION_PREVIEW = 6;

const McpStatusChip: React.FC<{ status?: McpServerStatus; t: Translation }> = ({ status, t }) =>
  status ? (
    <span className={`ext-status is-${status.state}`}>
      {status.state === 'ready' ? t.mcpReady(status.tools.length) : status.state === 'starting' ? t.mcpStarting : t.mcpError}
    </span>
  ) : null;

const EnableSwitch: React.FC<{ label: string; enabled: boolean; onChange: (enabled: boolean) => void }> = ({ label, enabled, onChange }) => (
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

export const CustomizationsPage: React.FC<CustomizationsPageProps> = ({
  settings,
  setSettings,
  t,
  agentRunning,
  onBackToChat,
  onEditConfig,
}) => {
  const language = settings.language;
  const statuses = useMcpStatuses();
  const [tab, setTab] = useState<Tab>('marketplace');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const refreshSkills = useCallback(() => loadSkills(settings.cwd).then(setSkills), [settings.cwd]);
  useEffect(() => {
    void refreshSkills();
  }, [refreshSkills]);

  const applyPatch = useCallback(
    (patch: (prev: PluginSettings) => PluginSettings) => setSettings((prev) => ({ ...prev, ...patch(prev) })),
    [setSettings]
  );
  const closeDialog = useCallback(() => setSelectedId(null), []);

  const configBroken = readMcpEntries(settings.mcpConfig) === null;
  const statusOf = (name: string) => statuses.find((s) => s.name === name);
  const stateOf = (plugin: MarketplacePlugin) => pluginState(plugin, settings, skills);

  const installed = MARKETPLACE_PLUGINS.filter((plugin) => stateOf(plugin) !== 'available');
  const customServers = customMcpNames(settings);
  const ownSkills = customSkills(skills);
  const installedCount = installed.length + customServers.length + ownSkills.length;

  const q = query.trim().toLowerCase();
  const sections = useMemo(
    () =>
      PLUGIN_SECTIONS.map((section) => ({
        ...section,
        plugins: MARKETPLACE_PLUGINS.filter((p) => p.section === section.id && matchesQuery(p, q)),
      })).filter((section) => section.plugins.length > 0),
    [q]
  );
  const shownInstalled = installed.filter((plugin) => matchesQuery(plugin, q));
  const shownServers = customServers.filter((name) => name.toLowerCase().includes(q));
  const shownSkills = ownSkills.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(q));

  const toggleSection = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const removeCustomServer = (name: string) => {
    if (confirmRemove !== name) {
      setConfirmRemove(name);
      setTimeout(() => setConfirmRemove((prev) => (prev === name ? null : prev)), 3500);
      return;
    }
    setConfirmRemove(null);
    applyPatch((prev) => ({ mcpConfig: withMcpEntry(prev.mcpConfig, name, null) }));
  };

  const setSkillEnabled = (name: string, enabled: boolean) =>
    applyPatch((prev) => {
      const rest = (prev.disabledSkills ?? []).filter((s) => s.toLowerCase() !== name.toLowerCase());
      return { disabledSkills: enabled ? rest : [...rest, name] };
    });

  const selected = MARKETPLACE_PLUGINS.find((p) => p.id === selectedId) ?? null;

  const pluginSummary = (plugin: MarketplacePlugin, state: 'enabled' | 'disabled') =>
    plugin.install.kind === 'skill' ? (
      <span className="tool-tag">/{plugin.install.skillName}</span>
    ) : (
      state === 'enabled' && <McpStatusChip status={statusOf(plugin.id)} t={t} />
    );

  return (
    <div className="customizations">
      <div className="customizations-inner">
        <header className="customizations-head">
          <h1 className="customizations-title">{t.customizations}</h1>
          <div className="custom-tabs" role="group" aria-label={t.customizations}>
            <button
              type="button"
              className={`custom-tab ${tab === 'marketplace' ? 'is-active' : ''}`}
              aria-pressed={tab === 'marketplace'}
              onClick={() => setTab('marketplace')}
            >
              {t.marketplaceTab}
            </button>
            <button
              type="button"
              className={`custom-tab ${tab === 'installed' ? 'is-active' : ''}`}
              aria-pressed={tab === 'installed'}
              onClick={() => setTab('installed')}
            >
              {t.installedTab(installedCount)}
            </button>
          </div>
        </header>

        {agentRunning && (
          <div className="custom-notice">
            <span>{t.pluginAgentRunning}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onBackToChat}>
              {t.pluginBackToChat}
            </button>
          </div>
        )}

        {configBroken && (
          <div className="custom-notice is-danger" role="alert">
            <span>{t.pluginConfigBroken}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onEditConfig}>
              {t.pluginEditConfig}
            </button>
          </div>
        )}

        <div className="custom-search">
          <Search size={16} aria-hidden="true" />
          <label htmlFor="custom-search-input" className="sr-only">
            {t.pluginSearch}
          </label>
          <input
            id="custom-search-input"
            className="input"
            type="search"
            placeholder={t.pluginSearch}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {tab === 'marketplace' &&
          (sections.length === 0 ? (
            <p className="plugin-empty">{t.pluginNoResults}</p>
          ) : (
            sections.map((section) => {
              // ตอนค้นหาให้เห็นผลครบ ไม่ต้องกดดูเพิ่ม
              const open = q !== '' || expanded.has(section.id);
              const hiddenCount = section.plugins.length - SECTION_PREVIEW;
              const shown = open ? section.plugins : section.plugins.slice(0, SECTION_PREVIEW);
              return (
                <section key={section.id} className="plugin-section" aria-labelledby={`plugin-section-${section.id}`}>
                  <h2 id={`plugin-section-${section.id}`} className="plugin-section-title">
                    {section.title[language]}
                  </h2>
                  <p className="plugin-section-sub">{section.subtitle[language]}</p>
                  <ul className="plugin-grid">
                    {shown.map((plugin) => {
                      const state = stateOf(plugin);
                      return (
                        <li key={plugin.id}>
                          <button
                            type="button"
                            className="plugin-card"
                            title={plugin.description[language]}
                            aria-label={`${plugin.name}: ${plugin.description[language]}`}
                            onClick={() => setSelectedId(plugin.id)}
                          >
                            <PluginIcon plugin={plugin} />
                            <span className="plugin-card-text">
                              <span className="plugin-card-name">
                                {plugin.name}
                                {plugin.community && <span className="tool-tag">{t.pluginCommunity}</span>}
                              </span>
                              <span className="plugin-card-desc">{plugin.description[language]}</span>
                            </span>
                            {state === 'available' ? (
                              <span className="plugin-card-action">
                                <Plus size={18} aria-hidden="true" />
                              </span>
                            ) : state === 'disabled' ? (
                              <span className="plugin-badge">{t.pluginDisabled}</span>
                            ) : (
                              <span className="plugin-badge is-on">
                                <Check size={12} aria-hidden="true" />
                                {t.pluginInstalled}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {q === '' && hiddenCount > 0 && (
                    <button type="button" className="plugin-see-more" aria-expanded={open} onClick={() => toggleSection(section.id)}>
                      {open ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
                      {open ? t.pluginSeeLess : t.pluginSeeMore(hiddenCount)}
                    </button>
                  )}
                </section>
              );
            })
          ))}

        {tab === 'installed' && (
          <>
            {installedCount === 0 ? (
              <div className="plugin-empty">
                <p>{t.pluginNothingInstalled}</p>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTab('marketplace')}>
                  {t.pluginBrowseMarketplace}
                </button>
              </div>
            ) : shownInstalled.length + shownServers.length + shownSkills.length === 0 ? (
              <p className="plugin-empty">{t.pluginNoResults}</p>
            ) : (
              <ul className="installed-list">
                {shownInstalled.map((plugin) => {
                  const state = stateOf(plugin) as 'enabled' | 'disabled';
                  const status = state === 'enabled' ? statusOf(plugin.id) : undefined;
                  return (
                    <li key={plugin.id} className="installed-row">
                      <PluginIcon plugin={plugin} />
                      <div className="ext-item-text">
                        <div className="ext-item-name">
                          {plugin.name}
                          {state === 'disabled' && <span className="plugin-badge">{t.pluginDisabled}</span>}
                          {pluginSummary(plugin, state)}
                        </div>
                        <p className="field-hint">{plugin.description[language]}</p>
                        {status?.error && <pre className="tool-error mcp-error">{status.error}</pre>}
                      </div>
                      {status?.state === 'error' && (
                        <button
                          type="button"
                          className="icon-btn icon-btn-sm"
                          onClick={() => mcpManager.restart(status.key)}
                          aria-label={`${t.mcpRestart}: ${plugin.name}`}
                          title={t.mcpRestart}
                        >
                          <RotateCcw size={14} aria-hidden="true" />
                        </button>
                      )}
                      <button
                        type="button"
                        className="icon-btn icon-btn-sm"
                        onClick={() => setSelectedId(plugin.id)}
                        aria-label={`${t.pluginManage}: ${plugin.name}`}
                        title={t.pluginManage}
                      >
                        <Settings2 size={15} aria-hidden="true" />
                      </button>
                      <EnableSwitch
                        label={plugin.name}
                        enabled={state === 'enabled'}
                        onChange={(enabled) => applyPatch((prev) => enabledPatch(plugin, enabled, prev))}
                      />
                    </li>
                  );
                })}

                {shownServers.map((name) => {
                  const entry = readMcpEntries(settings.mcpConfig)?.[name];
                  const disabled = isMcpEntryDisabled(entry);
                  const status = disabled ? undefined : statusOf(name);
                  const confirming = confirmRemove === name;
                  return (
                    <li key={`mcp:${name}`} className="installed-row">
                      <PluginTile>
                        <Plug size={20} />
                      </PluginTile>
                      <div className="ext-item-text">
                        <div className="ext-item-name">
                          <code>{name}</code>
                          <span className="tool-tag">{t.pluginAddedByYou}</span>
                          {disabled && <span className="plugin-badge">{t.pluginDisabled}</span>}
                          <McpStatusChip status={status} t={t} />
                        </div>
                        {status?.state === 'ready' && status.tools.length > 0 && <p className="field-hint">{status.tools.join(', ')}</p>}
                        {status?.error && <pre className="tool-error mcp-error">{status.error}</pre>}
                      </div>
                      {status && (
                        <button
                          type="button"
                          className="icon-btn icon-btn-sm"
                          onClick={() => mcpManager.restart(status.key)}
                          aria-label={`${t.mcpRestart}: ${name}`}
                          title={t.mcpRestart}
                        >
                          <RotateCcw size={14} aria-hidden="true" />
                        </button>
                      )}
                      <button
                        type="button"
                        className={`icon-btn icon-btn-sm ${confirming ? 'is-danger' : ''}`}
                        onClick={() => removeCustomServer(name)}
                        aria-label={`${confirming ? t.pluginConfirmUninstall : t.pluginUninstall}: ${name}`}
                        title={confirming ? t.pluginConfirmUninstall : t.pluginUninstall}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                      <EnableSwitch
                        label={name}
                        enabled={!disabled}
                        onChange={(enabled) =>
                          applyPatch((prev) => ({ mcpConfig: withMcpEntryDisabled(prev.mcpConfig, name, !enabled) }))
                        }
                      />
                    </li>
                  );
                })}

                {shownSkills.map((skill) => {
                  const off = (settings.disabledSkills ?? []).some((s) => s.toLowerCase() === skill.name.toLowerCase());
                  return (
                    <li key={skill.dir} className="installed-row" title={skill.dir}>
                      <PluginTile>
                        <Sparkles size={20} />
                      </PluginTile>
                      <div className="ext-item-text">
                        <div className="ext-item-name">
                          <code>/{skill.name}</code>
                          <span className="tool-tag">{skill.source === 'workspace' ? t.skillSourceWorkspace : t.skillSourceUser}</span>
                          {off && <span className="plugin-badge">{t.pluginDisabled}</span>}
                        </div>
                        <p className="field-hint">{skill.description}</p>
                      </div>
                      <EnableSwitch label={skill.name} enabled={!off} onChange={(enabled) => setSkillEnabled(skill.name, enabled)} />
                    </li>
                  );
                })}
              </ul>
            )}
            <button type="button" className="plugin-see-more" onClick={onEditConfig}>
              <Settings2 size={15} aria-hidden="true" />
              {t.pluginEditConfig}
            </button>
          </>
        )}
      </div>

      {selected && (
        <PluginDialog
          key={selected.id}
          plugin={selected}
          state={stateOf(selected)}
          status={stateOf(selected) === 'enabled' ? statusOf(selected.id) : undefined}
          uninstallable={canUninstall(selected, skills)}
          language={language}
          t={t}
          onInstall={async (values) => {
            await prepareInstall(selected, values, settings);
            applyPatch((prev) => installPatch(selected, prev));
            await refreshSkills();
          }}
          onUninstall={async () => {
            await prepareUninstall(selected);
            applyPatch((prev) => uninstallPatch(selected, prev));
            await refreshSkills();
            closeDialog();
          }}
          onSetEnabled={(enabled) => applyPatch((prev) => enabledPatch(selected, enabled, prev))}
          onSaveKeys={async (values) => {
            await saveSecrets(values);
            // config ไม่เปลี่ยน (อ้าง ${NAME} เหมือนเดิม) sync จึงไม่เปิด server ใหม่ให้ — ต้องสั่งเอง
            const status = statusOf(selected.id);
            if (status) mcpManager.restart(status.key);
          }}
          onRestart={() => {
            const status = statusOf(selected.id);
            if (status) mcpManager.restart(status.key);
          }}
          onClose={closeDialog}
        />
      )}
    </div>
  );
};
