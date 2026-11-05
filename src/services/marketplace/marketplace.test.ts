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
  installedTarget,
  matchesQuery,
  pluginHasUpdate,
  pluginRuntime,
  pluginState,
  pluginTarget,
  prepareInstall,
  prepareUninstall,
  readManagedSkillFiles,
  renderSkillFile,
  uninstallPatch,
  updatePatch,
} from './plugins';

const bridge = vi.hoisted(() => ({
  saveMcpSecret: vi.fn(async () => {}),
  installUserSkill: vi.fn(async () => 'dir'),
  uninstallUserSkill: vi.fn(async () => {}),
  readSkillFile: vi.fn(async (_dir: string, _file?: string, _workspace?: string) => ''),
}));
vi.mock('../tauriBridge', () => ({ tauriBridge: bridge }));

const byId = (id: string) => MARKETPLACE_PLUGINS.find((p) => p.id === id) as MarketplacePlugin;
const mcpPlugin = byId('context7');
const keyedPlugin = byId('brave-search');
const skillPlugin = byId('code-review');

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

  it.each(
    MARKETPLACE_PLUGINS.filter((p) => p.install.kind === 'mcp' && p.install.server.command).map((p) => [p.id, p] as const)
  )('%s pins an exact package version and names a runtime', (_id, plugin) => {
    if (plugin.install.kind !== 'mcp') throw new Error('unreachable');
    const { command, args } = plugin.install.server as { command: string; args: string[] };
    // คำสั่งอื่นต้องเพิ่มใน pluginRuntime ด้วย ไม่งั้นผู้ใช้ไม่รู้ว่าเครื่องขาดอะไร
    expect(['npx', 'uvx']).toContain(command);
    expect(pluginRuntime(plugin)?.command).toBe(command);
    const spec = command === 'npx' ? args[1] : args[0];
    if (command === 'npx') expect(args[0]).toBe('-y');
    // ไม่ pin = เปิดแอปครั้งถัดไปอาจได้โค้ดเวอร์ชันใหม่มารันโดยไม่มีใครถาม
    expect(spec).toMatch(/^(@[\w-]+\/)?[\w.-]+@\d+(\.\d+)+$/);
  });

  it('sends remote servers over https only', () => {
    for (const plugin of MARKETPLACE_PLUGINS) {
      if (plugin.install.kind === 'mcp' && plugin.install.server.url) {
        expect(plugin.install.server.url, plugin.id).toMatch(/^https:\/\//);
      }
    }
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

describe('plugin updates', () => {
  const pinned = byId('sequential-thinking');
  const server = (pinned.install as { server: Record<string, any> }).server;
  const configWith = (entry: Record<string, unknown>) => JSON.stringify({ mcpServers: { [pinned.id]: entry } });

  it('finds nothing to update right after install', () => {
    const settings = installPatch(pinned, {});
    expect(pluginHasUpdate(pinned, settings, {})).toBe(false);
    expect(pluginHasUpdate(mcpPlugin, installPatch(mcpPlugin, {}), {})).toBe(false);
  });

  it('finds nothing when the plugin is not installed or the config is broken', () => {
    expect(pluginHasUpdate(pinned, {}, {})).toBe(false);
    expect(pluginHasUpdate(pinned, { mcpConfig: '{ broken' }, {})).toBe(false);
  });

  it('flags an older version and an entry installed before versions were pinned', () => {
    const older = { ...server, args: ['-y', '@modelcontextprotocol/server-sequential-thinking@1.0.0'] };
    expect(pluginHasUpdate(pinned, { mcpConfig: configWith(older) }, {})).toBe(true);
    const unpinned = { ...server, args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] };
    const settings = { mcpConfig: configWith(unpinned) };
    expect(pluginHasUpdate(pinned, settings, {})).toBe(true);
    expect(installedTarget(pinned, settings)).toBe('npx -y @modelcontextprotocol/server-sequential-thinking');
    expect(pluginTarget(pinned)).toMatch(/server-sequential-thinking@\d/);
  });

  it('flags a key that was renamed in the catalog', () => {
    const sentry = byId('sentry');
    const entry = (sentry.install as { server: Record<string, any> }).server;
    const old = JSON.stringify({ mcpServers: { sentry: { ...entry, env: { SENTRY_AUTH_TOKEN: '${SENTRY_AUTH_TOKEN}' } } } });
    expect(pluginHasUpdate(sentry, { mcpConfig: old }, {})).toBe(true);
  });

  it('does not treat turning a plugin off as an update', () => {
    const off = enabledPatch(pinned, false, installPatch(pinned, {}));
    expect(pluginHasUpdate(pinned, off, {})).toBe(false);
    expect(pluginHasUpdate(pinned, enabledPatch(pinned, true, off), {})).toBe(false);
  });

  it('brings the entry up to date and keeps what belongs to the user', () => {
    const settings = {
      mcpConfig: configWith({ command: 'npx', args: ['-y', 'old@1.0.0'], env: { OLD_VAR: 'x' }, disabled: true, cwd: 'D:/mine' }),
    };
    const next = updatePatch(pinned, settings);
    const entry = readMcpEntries(next.mcpConfig)![pinned.id];
    expect(entry.args).toEqual(server.args);
    expect(entry.env).toBeUndefined();
    expect(entry.disabled).toBe(true);
    expect(entry.cwd).toBe('D:/mine');
    expect(pluginState(pinned, next, [])).toBe('disabled');
    // ไม่ถูกติดป้ายซ้ำหลังอัปเดต
    expect(pluginHasUpdate(pinned, next, {})).toBe(false);
  });

  it('keeps other servers when updating', () => {
    const text = JSON.stringify({ mcpServers: { mine: { command: 'x' }, [pinned.id]: { command: 'npx', args: [] } } });
    expect(Object.keys(readMcpEntries(updatePatch(pinned, { mcpConfig: text }).mcpConfig)!)).toEqual(['mine', pinned.id]);
  });

  it('compares skills by the installed file, and only for ones it installed', () => {
    if (skillPlugin.install.kind !== 'skill') throw new Error('unreachable');
    const current = renderSkillFile(skillPlugin.install);
    expect(pluginHasUpdate(skillPlugin, {}, {})).toBe(false);
    expect(pluginHasUpdate(skillPlugin, {}, { 'code-review': current })).toBe(false);
    expect(pluginHasUpdate(skillPlugin, {}, { 'code-review': `${current}\nedited` })).toBe(true);
    expect(updatePatch(skillPlugin, {})).toEqual({});
  });

  it('reads only managed skills and survives an unreadable file', async () => {
    bridge.readSkillFile.mockReset();
    bridge.readSkillFile.mockImplementation(async (dir: string) => {
      if (dir.endsWith('broken')) throw new Error('gone');
      return `text of ${dir}`;
    });
    const files = await readManagedSkillFiles(
      [skill('Code-Review', { managed: true }), skill('broken', { managed: true }), skill('mine')],
      'D:/ws'
    );
    expect(files).toEqual({ 'code-review': 'text of C:/skills/Code-Review' });
    expect(bridge.readSkillFile).toHaveBeenCalledTimes(2);
    expect(bridge.readSkillFile).toHaveBeenCalledWith('C:/skills/Code-Review', undefined, 'D:/ws');
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
    expect(pluginTarget(byId('sequential-thinking'))).toMatch(/^npx -y @modelcontextprotocol\/server-sequential-thinking@\d/);
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
