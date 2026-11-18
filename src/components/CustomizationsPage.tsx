import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Plug, Plus, RotateCcw, Search, Settings2, Sparkles, Trash2 } from 'lucide-react';
import { useMcpStatuses } from '../hooks/useMcpStatuses';
import { toolLimitOf } from '../services/agent/providers/toolLimits';
import { loadSkills, USE_SKILL_TOOL } from '../services/agent/skills';
import { chatBuiltinTools } from '../services/agent/subagent';
import { isMcpEntryDisabled, readMcpEntries, withMcpEntry, withMcpEntryDisabled, withMcpToolsDisabled } from '../services/mcp/config';
import { mcpManager, type McpServerStatus } from '../services/mcp/manager';
import { describeOauthError, mcpStatusLabel } from '../services/mcp/oauth';
import { summarizeToolUsage } from '../services/mcp/toolUsage';
import { MARKETPLACE_PLUGINS, PLUGIN_SECTIONS, type MarketplacePlugin } from '../services/marketplace/catalog';
import {
  canUninstall,
  customMcpNames,
  customSkills,
  enabledPatch,
  installPatch,
  installedTarget,
  matchesQuery,
  needsOauthMigration,
  pluginHasUpdate,
  pluginState,
  pluginTarget,
  prepareInstall,
  prepareRemoveCustomServer,
  prepareUninstall,
  readManagedSkillFiles,
  removeLegacySecrets,
  saveSecrets,
  uninstallPatch,
  updatePatch,
  type PluginSettings,
} from '../services/marketplace/plugins';
import type { SkillInfo } from '../services/tauriBridge';
import { PROVIDERS_CATALOG, type AppSettings } from '../types/agent';
import type { Translation } from '../utils/i18n';
import { McpSignInButton } from './McpSignInButton';
import { EnableSwitch, McpToolList, McpUsageSummary } from './McpToolUsage';
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
  status ? <span className={`ext-status is-${status.state}`}>{mcpStatusLabel(status, t)}</span> : null;

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
  const [skillFiles, setSkillFiles] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const refreshSkills = useCallback(async () => {
    const found = await loadSkills(settings.cwd);
    setSkills(found);
    setSkillFiles(await readManagedSkillFiles(found, settings.cwd));
  }, [settings.cwd]);
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
  const hasUpdate = (plugin: MarketplacePlugin) => pluginHasUpdate(plugin, settings, skillFiles);

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
    setRemoveError(null);
    // ลบ token ก่อน: ถ้าลบไม่ได้ server ยังอยู่ในรายการให้ลองใหม่ได้ ไม่ทิ้ง token ไว้โดยไม่มีใครรู้
    prepareRemoveCustomServer(name, settings)
      .then(() => applyPatch((prev) => ({ mcpConfig: withMcpEntry(prev.mcpConfig, name, null) })))
      .catch((err) => setRemoveError(describeOauthError(err, t)));
  };

  const setSkillEnabled = (name: string, enabled: boolean) =>
    applyPatch((prev) => {
      const rest = (prev.disabledSkills ?? []).filter((s) => s.toLowerCase() !== name.toLowerCase());
      return { disabledSkills: enabled ? rest : [...rest, name] };
    });

  /** รายการ tool ของ server ที่พร้อมใช้ — ยังไม่เชื่อมต่อจะยังไม่รู้ว่ามี tool อะไร */
  const toolList = (status: McpServerStatus | undefined, label: string) =>
    status?.state === 'ready' &&
    status.toolInfo.length > 0 && (
      <McpToolList
        status={status}
        serverLabel={label}
        t={t}
        onSetDisabled={(tools, disabled) =>
          applyPatch((prev) => ({ mcpConfig: withMcpToolsDisabled(prev.mcpConfig, status.name, tools, disabled) }))
        }
      />
    );

  // ชุดเดียวกับที่ AgentService ส่งให้โมเดล — ตัวเลขในหน้านี้จึงตรงกับของจริง
  const disabledSkills = new Set((settings.disabledSkills ?? []).map((name) => name.toLowerCase()));
  const usesSkillTool = skills.some((skill) => !disabledSkills.has(skill.name.toLowerCase()));
  const usage = summarizeToolUsage(statuses, [...chatBuiltinTools(settings), ...(usesSkillTool ? [USE_SKILL_TOOL] : [])]);
  const providerName = PROVIDERS_CATALOG.find((p) => p.id === settings.provider)?.name ?? settings.provider;
  const hasMcpServers = Object.keys(readMcpEntries(settings.mcpConfig) ?? {}).length > 0;

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

        {removeError && (
          <div className="custom-notice is-danger" role="alert">
            <span>{removeError}</span>
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
                            ) : hasUpdate(plugin) ? (
                              <span className="plugin-badge is-update">{t.pluginUpdateAvailable}</span>
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
            {hasMcpServers && <McpUsageSummary usage={usage} limit={toolLimitOf(settings.provider)} providerName={providerName} t={t} />}
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
                        {status?.error && <pre className="tool-error mcp-error">{describeOauthError(status.error, t)}</pre>}
                        {status && <McpSignInButton status={status} t={t} />}
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
                      {hasUpdate(plugin) && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => setSelectedId(plugin.id)}
                          aria-label={`${t.pluginUpdate}: ${plugin.name}`}
                        >
                          {t.pluginUpdate}
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
                      {toolList(status, plugin.name)}
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
                        {status?.error && <pre className="tool-error mcp-error">{describeOauthError(status.error, t)}</pre>}
                        {status && <McpSignInButton status={status} t={t} />}
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
                      {toolList(status, name)}
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
          legacyAuth={needsOauthMigration(selected, settings)}
          hasUpdate={hasUpdate(selected)}
          currentTarget={(() => {
            // ถ้าตรงกับของใหม่ (เช่น เปลี่ยนแค่ env) แสดงซ้ำจะดูเหมือนไม่มีอะไรเปลี่ยน
            const current = installedTarget(selected, settings);
            return current !== pluginTarget(selected) ? current : null;
          })()}
          language={language}
          t={t}
          onInstall={async (values, signIn) => {
            await prepareInstall(selected, values, settings);
            // ล็อกอินก่อนเพิ่มใน config: ล็อกอินไม่สำเร็จก็ไม่เหลือ server ที่ใช้งานไม่ได้ค้างในรายการ
            await signIn?.();
            applyPatch((prev) => installPatch(selected, prev));
            await refreshSkills();
          }}
          onSignedIn={async () => {
            // ติดตั้งแบบคีย์ไว้: ล็อกอินแล้วเปลี่ยน config เป็นแบบ OAuth ให้เลย (sync เปิด server ใหม่เอง)
            if (needsOauthMigration(selected, settings)) {
              await removeLegacySecrets(selected);
              applyPatch((prev) => updatePatch(selected, prev));
              return;
            }
            const status = statusOf(selected.id);
            if (status) mcpManager.restart(status.key);
          }}
          onSignedOut={() => {
            const status = statusOf(selected.id);
            if (status) mcpManager.restart(status.key);
          }}
          onUpdate={async (values, signIn) => {
            // config เปลี่ยน sync จึงเปิด server ใหม่ให้เอง (ถ้าผู้ใช้ปิดไว้ก็ยังปิดอยู่)
            await prepareInstall(selected, values, settings);
            // ย้ายจากคีย์มาล็อกอิน: ล็อกอินให้ได้ก่อน แล้วค่อยลบคีย์เดิมที่ยังใช้งานได้อยู่
            await signIn?.();
            await removeLegacySecrets(selected);
            applyPatch((prev) => updatePatch(selected, prev));
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
