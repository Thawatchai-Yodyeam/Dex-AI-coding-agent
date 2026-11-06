import { isMcpEntryDisabled, readMcpEntries, withMcpEntry, withMcpEntryDisabled } from '../mcp/config';
import { tauriBridge, type SkillInfo } from '../tauriBridge';
import { MARKETPLACE_PLUGINS, type MarketplacePlugin } from './catalog';

/**
 * สถานะการติดตั้งอ่านจากของจริงเสมอ (config ของ MCP, โฟลเดอร์ skill) ไม่มีรายการแยกต่างหาก
 * ผู้ใช้แก้ JSON ในตั้งค่าหรือลบโฟลเดอร์เองแล้ว หน้านี้จึงไม่มีทางแสดงไม่ตรงกับที่แอปใช้งานจริง
 */

export type PluginState = 'available' | 'enabled' | 'disabled';

/** ส่วนของ settings ที่ Marketplace แก้ */
export interface PluginSettings {
  mcpConfig?: string;
  disabledSkills?: string[];
}

const hasName = (list: string[] | undefined, name: string) =>
  (list ?? []).some((item) => item.toLowerCase() === name.toLowerCase());

const withoutName = (list: string[] | undefined, name: string) =>
  (list ?? []).filter((item) => item.toLowerCase() !== name.toLowerCase());

const findSkill = (skills: SkillInfo[], name: string) => skills.find((s) => s.name.toLowerCase() === name.toLowerCase());

export function pluginState(plugin: MarketplacePlugin, settings: PluginSettings, skills: SkillInfo[]): PluginState {
  if (plugin.install.kind === 'skill') {
    if (!findSkill(skills, plugin.install.skillName)) return 'available';
    return hasName(settings.disabledSkills, plugin.install.skillName) ? 'disabled' : 'enabled';
  }
  const entry = readMcpEntries(settings.mcpConfig)?.[plugin.id];
  if (!entry) return 'available';
  return isMcpEntryDisabled(entry) ? 'disabled' : 'enabled';
}

/** skill ชื่อเดียวกันที่ผู้ใช้เขียนเองหรือมากับโปรเจกต์ ห้ามถอนการติดตั้งจากหน้านี้ */
export function canUninstall(plugin: MarketplacePlugin, skills: SkillInfo[]): boolean {
  if (plugin.install.kind !== 'skill') return true;
  return findSkill(skills, plugin.install.skillName)?.managed === true;
}

export function renderSkillFile(install: Extract<MarketplacePlugin['install'], { kind: 'skill' }>): string {
  return `---\nname: ${install.skillName}\ndescription: ${install.summary}\n---\n\n${install.instructions.trim()}\n`;
}

/** ค่าที่กรอก → เก็บเฉพาะช่องที่มีข้อความ (เว้นว่าง = ใช้ค่าเดิมต่อ) */
export async function saveSecrets(values: Record<string, string>): Promise<void> {
  for (const [name, value] of Object.entries(values)) {
    if (value.trim()) await tauriBridge.saveMcpSecret(name, value.trim());
  }
}

/** ของที่อยู่นอก settings: คีย์และไฟล์ skill — ทำก่อน installPatch เพื่อไม่ให้ server เริ่มโดยยังไม่มีคีย์ */
export async function prepareInstall(plugin: MarketplacePlugin, values: Record<string, string>, settings: PluginSettings): Promise<void> {
  if (plugin.install.kind === 'mcp' && readMcpEntries(settings.mcpConfig) === null) {
    throw new Error('MCP config is not valid JSON');
  }
  await saveSecrets(values);
  if (plugin.install.kind === 'skill') {
    await tauriBridge.installUserSkill(plugin.install.skillName, renderSkillFile(plugin.install));
  }
}

export function installPatch(plugin: MarketplacePlugin, settings: PluginSettings): PluginSettings {
  if (plugin.install.kind === 'skill') {
    return { disabledSkills: withoutName(settings.disabledSkills, plugin.install.skillName) };
  }
  return { mcpConfig: withMcpEntry(settings.mcpConfig, plugin.id, plugin.install.server) };
}

/** ลบไฟล์ skill และคีย์ของ plugin — ทำก่อน uninstallPatch: ถ้าพังก็ยังถือว่าติดตั้งอยู่และลองใหม่ได้ */
export async function prepareUninstall(plugin: MarketplacePlugin): Promise<void> {
  if (plugin.install.kind === 'skill') await tauriBridge.uninstallUserSkill(plugin.install.skillName);
  for (const secret of plugin.secrets ?? []) await tauriBridge.saveMcpSecret(secret.name, '');
}

export function uninstallPatch(plugin: MarketplacePlugin, settings: PluginSettings): PluginSettings {
  if (plugin.install.kind === 'skill') {
    return { disabledSkills: withoutName(settings.disabledSkills, plugin.install.skillName) };
  }
  return { mcpConfig: withMcpEntry(settings.mcpConfig, plugin.id, null) };
}

export function enabledPatch(plugin: MarketplacePlugin, enabled: boolean, settings: PluginSettings): PluginSettings {
  if (plugin.install.kind === 'skill') {
    const rest = withoutName(settings.disabledSkills, plugin.install.skillName);
    return { disabledSkills: enabled ? rest : [...rest, plugin.install.skillName] };
  }
  return { mcpConfig: withMcpEntryDisabled(settings.mcpConfig, plugin.id, !enabled) };
}

/**
 * ฟิลด์ที่ catalog เป็นเจ้าของ — ฟิลด์อื่นใน entry (disabled, cwd ฯลฯ) เป็นของผู้ใช้
 * ต้องคงไว้ตอนอัปเดต และเปลี่ยนสถานะเปิด/ปิดแล้วต้องไม่ถูกนับว่ามีเวอร์ชันใหม่
 */
const CATALOG_MCP_FIELDS = ['type', 'transport', 'command', 'args', 'env', 'url', 'headers'];

/**
 * ของที่ติดตั้งไว้ไม่ตรงกับ catalog — ไม่อัปเดตให้เองเพราะจะได้โค้ดใหม่มารันโดยผู้ใช้ไม่รู้
 * skillFiles: เนื้อหา SKILL.md จาก readManagedSkillFiles
 */
export function pluginHasUpdate(plugin: MarketplacePlugin, settings: PluginSettings, skillFiles: Record<string, string>): boolean {
  if (plugin.install.kind === 'skill') {
    const current = skillFiles[plugin.install.skillName.toLowerCase()];
    return current !== undefined && current !== renderSkillFile(plugin.install);
  }
  const entry = readMcpEntries(settings.mcpConfig)?.[plugin.id];
  if (!entry) return false;
  const { server } = plugin.install;
  return CATALOG_MCP_FIELDS.some((field) => JSON.stringify(entry[field]) !== JSON.stringify(server[field]));
}

/** ใช้คู่กับ prepareInstall ซึ่งเก็บคีย์ใหม่และเขียนไฟล์ skill ทับให้แล้ว */
export function updatePatch(plugin: MarketplacePlugin, settings: PluginSettings): PluginSettings {
  if (plugin.install.kind === 'skill') return {};
  const entry = readMcpEntries(settings.mcpConfig)?.[plugin.id] ?? {};
  const kept = Object.fromEntries(Object.entries(entry).filter(([field]) => !CATALOG_MCP_FIELDS.includes(field)));
  return { mcpConfig: withMcpEntry(settings.mcpConfig, plugin.id, { ...kept, ...plugin.install.server }) };
}

/** เนื้อหา SKILL.md ของ skill ที่ Marketplace ติดตั้ง (ชื่อตัวพิมพ์เล็ก → เนื้อหา) อ่านไม่ได้ก็ถือว่าไม่มีอัปเดต */
export async function readManagedSkillFiles(skills: SkillInfo[], cwd: string): Promise<Record<string, string>> {
  const files = await Promise.all(
    skills
      .filter((skill) => skill.managed)
      .map(async (skill): Promise<[string, string] | null> => {
        try {
          return [skill.name.toLowerCase(), await tauriBridge.readSkillFile(skill.dir, undefined, cwd)];
        } catch {
          return null;
        }
      })
  );
  return Object.fromEntries(files.filter((file) => file !== null));
}

/** โปรแกรมที่เครื่องต้องมีก่อน plugin จะรันได้ */
export function pluginRuntime(plugin: MarketplacePlugin): { command: string; name: string; url: string } | null {
  if (plugin.install.kind !== 'mcp') return null;
  if (plugin.install.server.command === 'npx') return { command: 'npx', name: 'Node.js', url: 'https://nodejs.org/' };
  if (plugin.install.server.command === 'uvx') {
    return { command: 'uvx', name: 'uv', url: 'https://docs.astral.sh/uv/getting-started/installation/' };
  }
  return null;
}

const mcpTarget = (entry: Record<string, unknown>): string =>
  typeof entry.url === 'string' ? entry.url : [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].join(' ');

/** บรรทัดคำสั่ง หรือ URL ที่ผู้ใช้ต้องเห็นก่อนกดติดตั้ง */
export function pluginTarget(plugin: MarketplacePlugin): string {
  if (plugin.install.kind === 'skill') return `~/.dex/skills/${plugin.install.skillName}/SKILL.md`;
  return mcpTarget(plugin.install.server);
}

/** คำสั่งหรือ URL ที่ติดตั้งอยู่จริงตอนนี้ */
export function installedTarget(plugin: MarketplacePlugin, settings: PluginSettings): string | null {
  if (plugin.install.kind !== 'mcp') return null;
  const entry = readMcpEntries(settings.mcpConfig)?.[plugin.id];
  return entry ? mcpTarget(entry) : null;
}

export function matchesQuery(plugin: MarketplacePlugin, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [plugin.name, plugin.publisher, plugin.id, plugin.description.th, plugin.description.en].some((text) =>
    text.toLowerCase().includes(q)
  );
}

/** server ใน config ที่ไม่ได้มาจาก Marketplace (ผู้ใช้วาง JSON เอง) */
export function customMcpNames(settings: PluginSettings): string[] {
  const known = new Set(MARKETPLACE_PLUGINS.filter((p) => p.install.kind === 'mcp').map((p) => p.id));
  return Object.keys(readMcpEntries(settings.mcpConfig) ?? {}).filter((name) => !known.has(name));
}

/** skill ที่ค้นเจอแต่ไม่ได้มาจาก Marketplace */
export function customSkills(skills: SkillInfo[]): SkillInfo[] {
  const known = new Set(
    MARKETPLACE_PLUGINS.flatMap((p) => (p.install.kind === 'skill' ? [p.install.skillName.toLowerCase()] : []))
  );
  return skills.filter((skill) => !known.has(skill.name.toLowerCase()));
}
