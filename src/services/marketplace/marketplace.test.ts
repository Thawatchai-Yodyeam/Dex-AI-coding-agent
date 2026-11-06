import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMcpConfig, readMcpEntries, withMcpEntry, withMcpEntryDisabled } from '../mcp/config';
import type { SkillInfo } from '../tauriBridge';
import { stripFrontmatter } from '../agent/skills';
import { MARKETPLACE_PLUGINS, PLUGIN_SECTIONS, type MarketplacePlugin } from './catalog';
import {
  canUninstall,
  customMcpNames,
  customSkills,
  enabledPatch,
  installPatch,
  matchesQuery,
  needsOauthMigration,
  oauthMigrationPatch,
  pluginRuntime,
  pluginState,
  pluginTarget,
  prepareInstall,
  prepareRemoveCustomServer,
  prepareUninstall,
  removeLegacySecrets,
  renderSkillFile,
  uninstallPatch,
  usesOauth,
} from './plugins';

const bridge = vi.hoisted(() => ({
  saveMcpSecret: vi.fn(async () => {}),
  installUserSkill: vi.fn(async () => 'dir'),
  uninstallUserSkill: vi.fn(async () => {}),
  mcpOauthLogout: vi.fn(async () => {}),
}));
vi.mock('../tauriBridge', () => ({ tauriBridge: bridge }));

const byId = (id: string) => MARKETPLACE_PLUGINS.find((p) => p.id === id) as MarketplacePlugin;
const mcpPlugin = byId('context7');
const keyedPlugin = byId('brave-search');
const skillPlugin = byId('code-review');
const oauthPlugin = byId('supabase');

const skill = (name: string, extra: Partial<SkillInfo> = {}): SkillInfo => ({
  name,
  description: 'd',
  dir: `C:/skills/${name}`,
  source: 'user',
  ...extra,
});

/** ตัวแปร `${NAME}` ทั้งหมดใน entry */
function referencedVars(value: unknown): string[] {
  return [...JSON.stringify(value).matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
}

describe('catalog', () => {
  it('has unique ids that are safe in tool names', () => {
    const ids = MARKETPLACE_PLUGINS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
      // ยาวกว่านี้ serverKey จะตัดจนชื่อ tool ไม่ตรงกับชื่อ server
      expect(id.length).toBeLessThanOrEqual(24);
    }
  });

  it('puts every plugin in a section and fills in both languages', () => {
    const sections = new Set(PLUGIN_SECTIONS.map((s) => s.id));
    for (const plugin of MARKETPLACE_PLUGINS) {
      expect(sections.has(plugin.section), plugin.id).toBe(true);
      expect(plugin.description.th.trim(), plugin.id).not.toBe('');
      expect(plugin.description.en.trim(), plugin.id).not.toBe('');
      expect(plugin.homepage, plugin.id).toMatch(/^https:\/\//);
    }
    for (const section of PLUGIN_SECTIONS) {
      expect(MARKETPLACE_PLUGINS.some((p) => p.section === section.id), section.id).toBe(true);
    }
  });

  it.each(MARKETPLACE_PLUGINS.filter((p) => p.install.kind === 'mcp').map((p) => [p.id, p] as const))(
    '%s produces a config the MCP parser accepts',
    (_id, plugin) => {
      if (plugin.install.kind !== 'mcp') throw new Error('unreachable');
      const parsed = parseMcpConfig(withMcpEntry('', plugin.id, plugin.install.server));
      expect(parsed.errors).toEqual([]);
      expect(parsed.servers).toHaveLength(1);
      expect(parsed.servers[0].key).toBe(plugin.id);
    }
  );

  it.each(MARKETPLACE_PLUGINS.filter((p) => p.install.kind === 'mcp').map((p) => [p.id, p] as const))(
    '%s declares exactly the secrets it references and keeps them out of args',
    (_id, plugin) => {
      if (plugin.install.kind !== 'mcp') throw new Error('unreachable');
      const declared = (plugin.secrets ?? []).map((s) => s.name).sort();
      const used = referencedVars(plugin.install.server).filter((name) => name !== 'USERPROFILE');
      expect([...new Set(used)].sort()).toEqual(declared);
      // args ของ process อ่านได้จาก process อื่นในเครื่อง
      expect(referencedVars(plugin.install.server.args ?? [])).toEqual([]);
      for (const secret of plugin.secrets ?? []) expect(secret.helpUrl).toMatch(/^https:\/\//);
    }
  );

  it('sends remote servers over https only', () => {
    for (const plugin of MARKETPLACE_PLUGINS) {
      if (plugin.install.kind === 'mcp' && plugin.install.server.url) {
        expect(plugin.install.server.url, plugin.id).toMatch(/^https:\/\//);
      }
    }
  });

  it('lists the hosted servers that sign in with a browser', () => {
    expect(MARKETPLACE_PLUGINS.filter(usesOauth).map((p) => p.id).sort()).toEqual(['cloudflare', 'linear', 'neon', 'notion', 'sentry', 'supabase']);
    expect(usesOauth(skillPlugin)).toBe(false);
    expect(usesOauth(keyedPlugin)).toBe(false);
  });

  it.each(MARKETPLACE_PLUGINS.filter(usesOauth).map((p) => [p.id, p] as const))('%s signs in over https and asks for no keys', (_id, plugin) => {
    if (plugin.install.kind !== 'mcp') throw new Error('unreachable');
    expect(plugin.secrets ?? []).toEqual([]);
    expect(plugin.install.server.headers).toBeUndefined();
    expect(plugin.install.server.url).toMatch(/^https:\/\//);
    expect(pluginRuntime(plugin)).toBeNull();
    const [server] = parseMcpConfig(withMcpEntry('', plugin.id, plugin.install.server)).servers;
    expect(server.auth).toBe('oauth');
    // คีย์เดิมต้องไม่ใช้ชื่อเดียวกับคีย์ของ plugin อื่น ไม่งั้นถอนตัวนี้แล้วตัวอื่นพัง
    const others = MARKETPLACE_PLUGINS.filter((p) => p.id !== plugin.id).flatMap((p) => (p.secrets ?? []).map((s) => s.name));
    for (const name of plugin.legacySecrets ?? []) expect(others).not.toContain(name);
  });

  it.each(MARKETPLACE_PLUGINS.filter((p) => p.install.kind === 'skill').map((p) => [p.id, p] as const))(
    '%s renders a SKILL.md the app can read',
    (_id, plugin) => {
      if (plugin.install.kind !== 'skill') throw new Error('unreachable');
      // เงื่อนไขเดียวกับ valid_provider_id ใน lib.rs
      expect(plugin.install.skillName).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      // parser ฝั่ง Rust รับ description บรรทัดเดียวเท่านั้น
      expect(plugin.install.summary).not.toMatch(/[\r\n]/);
      const file = renderSkillFile(plugin.install);
      expect(file.startsWith(`---\nname: ${plugin.install.skillName}\ndescription: `)).toBe(true);
      expect(stripFrontmatter(file)).toBe(plugin.install.instructions.trim());
    }
  );
});

describe('editing the MCP config', () => {
  const existing = JSON.stringify({
    mcpServers: { mine: { command: 'node', args: ['server.js'] } },
    otherSetting: true,
  });

  it('creates a config from nothing', () => {
    const next = withMcpEntry('', 'a', { url: 'https://example.com/mcp' });
    expect(JSON.parse(next)).toEqual({ mcpServers: { a: { url: 'https://example.com/mcp' } } });
  });

  it('keeps other servers and unknown keys when adding and removing', () => {
    const added = withMcpEntry(existing, 'a', { url: 'https://example.com/mcp' });
    expect(Object.keys(readMcpEntries(added)!)).toEqual(['mine', 'a']);
    expect(JSON.parse(added).otherSetting).toBe(true);
    expect(JSON.parse(withMcpEntry(added, 'a', null))).toEqual(JSON.parse(existing));
  });

  it('writes to the same place the parser reads for every accepted shape', () => {
    for (const shape of [{ servers: { x: { command: 'a' } } }, { x: { command: 'a' } }, {}]) {
      const next = withMcpEntry(JSON.stringify(shape), 'y', { command: 'b' });
      const names = parseMcpConfig(next).servers.map((s) => s.name);
      expect(names).toContain('y');
      if (Object.keys(shape).length > 0) expect(names).toContain('x');
    }
  });

  it('refuses to overwrite a config it cannot parse', () => {
    expect(readMcpEntries('{ broken')).toBeNull();
    expect(() => withMcpEntry('{ broken', 'a', {})).toThrow();
    expect(() => withMcpEntryDisabled('{ broken', 'a', true)).toThrow();
  });

  it('disables a server without losing its config, and turns it back on', () => {
    const off = withMcpEntryDisabled(existing, 'mine', true);
    expect(parseMcpConfig(off).servers).toEqual([]);
    expect(readMcpEntries(off)!.mine.args).toEqual(['server.js']);
    const on = withMcpEntryDisabled(off, 'mine', false);
    expect(parseMcpConfig(on).servers.map((s) => s.name)).toEqual(['mine']);
    expect(readMcpEntries(on)!.mine.disabled).toBeUndefined();
  });

  it('also re-enables a server written with "enabled": false', () => {
    const text = JSON.stringify({ mcpServers: { a: { command: 'x', enabled: false } } });
    expect(parseMcpConfig(text).servers).toEqual([]);
    expect(parseMcpConfig(withMcpEntryDisabled(text, 'a', false)).servers).toHaveLength(1);
  });
});

describe('plugin state', () => {
  it('follows the MCP config', () => {
    expect(pluginState(mcpPlugin, {}, [])).toBe('available');
    const installed = installPatch(mcpPlugin, {});
    expect(pluginState(mcpPlugin, installed, [])).toBe('enabled');
    const off = enabledPatch(mcpPlugin, false, installed);
    expect(pluginState(mcpPlugin, off, [])).toBe('disabled');
    expect(parseMcpConfig(off.mcpConfig).servers).toEqual([]);
    expect(pluginState(mcpPlugin, enabledPatch(mcpPlugin, true, off), [])).toBe('enabled');
    expect(pluginState(mcpPlugin, uninstallPatch(mcpPlugin, installed), [])).toBe('available');
  });

  it('sees a server the user removed by hand as not installed', () => {
    const installed = installPatch(mcpPlugin, {});
    const edited = { mcpConfig: withMcpEntry(installed.mcpConfig, mcpPlugin.id, null) };
    expect(pluginState(mcpPlugin, edited, [])).toBe('available');
  });

  it('treats a broken config as nothing installed', () => {
    expect(pluginState(mcpPlugin, { mcpConfig: '{ broken' }, [])).toBe('available');
  });

  it('follows the skill folder and the disabled list', () => {
    const name = 'code-review';
    expect(pluginState(skillPlugin, {}, [])).toBe('available');
    const skills = [skill(name, { managed: true })];
    expect(pluginState(skillPlugin, {}, skills)).toBe('enabled');
    const off = enabledPatch(skillPlugin, false, {});
    expect(off.disabledSkills).toEqual([name]);
    expect(pluginState(skillPlugin, off, skills)).toBe('disabled');
    expect(enabledPatch(skillPlugin, true, off).disabledSkills).toEqual([]);
    // ติดตั้งใหม่ต้องไม่ติดสถานะปิดของครั้งก่อน
    expect(installPatch(skillPlugin, off).disabledSkills).toEqual([]);
    expect(uninstallPatch(skillPlugin, off).disabledSkills).toEqual([]);
  });

  it('only lets the marketplace uninstall skills it installed', () => {
    expect(canUninstall(skillPlugin, [skill('code-review', { managed: true })])).toBe(true);
    expect(canUninstall(skillPlugin, [skill('code-review')])).toBe(false);
    expect(canUninstall(skillPlugin, [skill('Code-Review', { source: 'workspace', managed: false })])).toBe(false);
    expect(canUninstall(mcpPlugin, [])).toBe(true);
  });
});

describe('install and uninstall side effects', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stores typed keys and skips blank fields', async () => {
    await prepareInstall(keyedPlugin, { BRAVE_API_KEY: '  secret  ', OTHER: '   ' }, {});
    expect(bridge.saveMcpSecret).toHaveBeenCalledTimes(1);
    expect(bridge.saveMcpSecret).toHaveBeenCalledWith('BRAVE_API_KEY', 'secret');
  });

  it('never writes the key into settings', () => {
    const patch = installPatch(keyedPlugin, {});
    expect(patch.mcpConfig).toContain('${BRAVE_API_KEY}');
    expect(referencedVars(patch.mcpConfig)).toEqual(['BRAVE_API_KEY']);
  });

  it('does not save anything when the MCP config is broken', async () => {
    await expect(prepareInstall(keyedPlugin, { BRAVE_API_KEY: 'x' }, { mcpConfig: '{ broken' })).rejects.toThrow();
    expect(bridge.saveMcpSecret).not.toHaveBeenCalled();
  });

  it('installs skills even when the MCP config is broken, since they do not touch it', async () => {
    await prepareInstall(skillPlugin, {}, { mcpConfig: '{ broken' });
    expect(bridge.installUserSkill).toHaveBeenCalledWith('code-review', expect.stringContaining('name: code-review'));
  });

  it('passes a failure back so the plugin is not marked installed', async () => {
    bridge.saveMcpSecret.mockRejectedValueOnce(new Error('keyring locked'));
    await expect(prepareInstall(keyedPlugin, { BRAVE_API_KEY: 'x' }, {})).rejects.toThrow('keyring locked');
  });

  it('removes the skill folder and the stored keys on uninstall', async () => {
    await prepareUninstall(skillPlugin);
    expect(bridge.uninstallUserSkill).toHaveBeenCalledWith('code-review');
    await prepareUninstall(keyedPlugin);
    expect(bridge.saveMcpSecret).toHaveBeenCalledWith('BRAVE_API_KEY', '');
    expect(bridge.mcpOauthLogout).not.toHaveBeenCalled();
  });

  it('deletes the sign-in on uninstall, along with a key left by an older version', async () => {
    await prepareUninstall(oauthPlugin);
    expect(bridge.mcpOauthLogout).toHaveBeenCalledTimes(1);
    expect(bridge.mcpOauthLogout).toHaveBeenCalledWith('supabase');
    expect(bridge.saveMcpSecret).toHaveBeenCalledWith('SUPABASE_ACCESS_TOKEN', '');
  });

  it('stays installed when the sign-in cannot be deleted, so uninstalling can be retried', async () => {
    bridge.mcpOauthLogout.mockRejectedValueOnce(new Error('OAUTH_STORE: locked'));
    await expect(prepareUninstall(oauthPlugin)).rejects.toThrow('OAUTH_STORE');
  });

  it('writes only a marker to settings for plugins that sign in', () => {
    const patch = installPatch(oauthPlugin, {});
    expect(JSON.parse(patch.mcpConfig!).mcpServers.supabase).toEqual({
      type: 'http',
      url: 'https://mcp.supabase.com/mcp?read_only=true',
      auth: 'oauth',
    });
    expect(referencedVars(patch.mcpConfig)).toEqual([]);
  });

  it('deletes the sign-in of a server added by hand when it is removed', async () => {
    const config = JSON.stringify({
      mcpServers: {
        'my server': { type: 'http', url: 'https://x/mcp', auth: 'oauth' },
        off: { type: 'http', url: 'https://y/mcp', auth: 'oauth', disabled: true },
        plain: { type: 'http', url: 'https://z/mcp' },
      },
    });
    await prepareRemoveCustomServer('my server', { mcpConfig: config });
    expect(bridge.mcpOauthLogout).toHaveBeenLastCalledWith('my_server');
    await prepareRemoveCustomServer('off', { mcpConfig: config });
    expect(bridge.mcpOauthLogout).toHaveBeenLastCalledWith('off');
    bridge.mcpOauthLogout.mockClear();
    await prepareRemoveCustomServer('plain', { mcpConfig: config });
    await prepareRemoveCustomServer('missing', { mcpConfig: config });
    expect(bridge.mcpOauthLogout).not.toHaveBeenCalled();
  });
});

describe('moving an older install to sign-in', () => {
  const legacyEntry = {
    type: 'http',
    url: 'https://mcp.supabase.com/mcp?read_only=true',
    headers: { Authorization: 'Bearer ${SUPABASE_ACCESS_TOKEN}' },
  };
  const legacy = { mcpConfig: withMcpEntry('', 'supabase', legacyEntry) };

  beforeEach(() => vi.clearAllMocks());

  it('keeps the old config working until the user signs in', () => {
    expect(pluginState(oauthPlugin, legacy, [])).toBe('enabled');
    expect(needsOauthMigration(oauthPlugin, legacy)).toBe(true);
    const [server] = parseMcpConfig(legacy.mcpConfig).servers;
    expect(server.auth).toBeUndefined();
    expect(server.headers?.Authorization).toContain('SUPABASE_ACCESS_TOKEN');
  });

  it('does not offer it for fresh installs, other plugins or nothing installed', () => {
    expect(needsOauthMigration(oauthPlugin, installPatch(oauthPlugin, {}))).toBe(false);
    expect(needsOauthMigration(oauthPlugin, {})).toBe(false);
    expect(needsOauthMigration(keyedPlugin, installPatch(keyedPlugin, {}))).toBe(false);
  });

  it('replaces the config and removes the old key', async () => {
    const patched = oauthMigrationPatch(oauthPlugin, legacy);
    expect(needsOauthMigration(oauthPlugin, patched)).toBe(false);
    expect(patched.mcpConfig).not.toContain('SUPABASE_ACCESS_TOKEN');
    await removeLegacySecrets(oauthPlugin);
    expect(bridge.saveMcpSecret).toHaveBeenCalledWith('SUPABASE_ACCESS_TOKEN', '');
  });

  it('keeps a disabled plugin disabled', () => {
    const off = { mcpConfig: withMcpEntryDisabled(legacy.mcpConfig, 'supabase', true) };
    const patched = oauthMigrationPatch(oauthPlugin, off);
    expect(pluginState(oauthPlugin, patched, [])).toBe('disabled');
    expect(readMcpEntries(patched.mcpConfig)!.supabase.auth).toBe('oauth');
  });
});

describe('page helpers', () => {
  it('searches names, publishers and both languages', () => {
    expect(matchesQuery(mcpPlugin, '')).toBe(true);
    expect(matchesQuery(mcpPlugin, 'CONTEXT')).toBe(true);
    expect(matchesQuery(mcpPlugin, 'upstash')).toBe(true);
    expect(matchesQuery(mcpPlugin, 'เอกสารล่าสุด')).toBe(true);
    expect(matchesQuery(mcpPlugin, 'libraries')).toBe(true);
    expect(matchesQuery(mcpPlugin, 'zzz')).toBe(false);
  });

  it('shows what will run before install', () => {
    expect(pluginTarget(byId('sequential-thinking'))).toBe('npx -y @modelcontextprotocol/server-sequential-thinking');
    expect(pluginTarget(mcpPlugin)).toBe('https://mcp.context7.com/mcp');
    expect(pluginTarget(skillPlugin)).toBe('~/.dex/skills/code-review/SKILL.md');
  });

  it('names the runtime a plugin needs', () => {
    expect(pluginRuntime(byId('memory'))?.name).toBe('Node.js');
    expect(pluginRuntime(byId('time'))?.name).toBe('uv');
    expect(pluginRuntime(mcpPlugin)).toBeNull();
    expect(pluginRuntime(skillPlugin)).toBeNull();
  });

  it('separates things added by hand from marketplace plugins', () => {
    const settings = installPatch(mcpPlugin, { mcpConfig: JSON.stringify({ mcpServers: { mine: { command: 'x' } } }) });
    expect(customMcpNames(settings)).toEqual(['mine']);
    expect(customMcpNames({ mcpConfig: '{ broken' })).toEqual([]);
    expect(customSkills([skill('code-review', { managed: true }), skill('my-own')]).map((s) => s.name)).toEqual(['my-own']);
  });
});
