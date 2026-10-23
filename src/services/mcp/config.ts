/**
 * การตั้งค่า MCP server ในรูปแบบเดียวกับ Claude Desktop / `.mcp.json`:
 *
 * { "mcpServers": {
 *     "fs":     { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/work"] },
 *     "remote": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${TOKEN}" } }
 * } }
 *
 * `${NAME}` ใน args/env/url/headers ถูกแทนด้วย environment variable ฝั่ง Rust (ไม่ต้องเก็บ token ไว้ใน settings)
 */

export interface McpServerConfig {
  /** ชื่อตามที่ผู้ใช้ตั้ง */
  name: string;
  /** ชื่อที่ใช้ใน prefix ของ tool (`mcp__<key>__tool`) — ตัวอักษรที่ API ทุกค่ายรับ */
  key: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** timeout ของแต่ละ request (ms) */
  timeoutMs?: number;
}

export interface ParsedMcpConfig {
  servers: McpServerConfig[];
  /** ปัญหาของ JSON ทั้งก้อน หรือของ server รายตัว (server ที่มีปัญหาจะถูกข้าม) */
  errors: string[];
}

export const MCP_CONFIG_EXAMPLE = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/projects"]
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer \${MY_TOKEN}" }
    }
  }
}`;

/** ชื่อ server → ส่วนหนึ่งของชื่อ tool: [a-zA-Z0-9_-] และไม่มี `__` (ใช้เป็นตัวคั่น) */
export function serverKey(name: string): string {
  const key = name
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  return (key || 'server').slice(0, 24);
}

const stringRecord = (v: unknown): Record<string, string> | undefined => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, String(val)]));
};

export function parseMcpConfig(text: string | undefined): ParsedMcpConfig {
  if (!text?.trim()) return { servers: [], errors: [] };
  let json: any;
  try {
    json = JSON.parse(text);
  } catch (err: any) {
    return { servers: [], errors: [`JSON: ${err?.message || String(err)}`] };
  }
  // รับได้ทั้งแบบมี `mcpServers` ห่อ และแบบวางเฉพาะข้างใน
  const entries = json && typeof json === 'object' ? (json.mcpServers ?? json.servers ?? json) : null;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    return { servers: [], errors: ['Expected an object like { "mcpServers": { "name": { ... } } }'] };
  }

  const servers: McpServerConfig[] = [];
  const errors: string[] = [];
  const usedKeys = new Set<string>();
  for (const [name, raw] of Object.entries(entries as Record<string, any>)) {
    if (!raw || typeof raw !== 'object') {
      errors.push(`${name}: must be an object`);
      continue;
    }
    if (raw.disabled === true || raw.enabled === false) continue;
    let key = serverKey(name);
    for (let i = 2; usedKeys.has(key); i++) key = `${serverKey(name).slice(0, 21)}_${i}`;
    const type = String(raw.type ?? raw.transport ?? (raw.url ? 'http' : 'stdio')).toLowerCase();
    const timeoutMs = Number.isFinite(raw.timeout) && raw.timeout > 0 ? Number(raw.timeout) : undefined;

    if (type === 'stdio') {
      if (typeof raw.command !== 'string' || !raw.command.trim()) {
        errors.push(`${name}: "command" is required`);
        continue;
      }
      servers.push({
        name,
        key,
        transport: 'stdio',
        command: raw.command.trim(),
        args: Array.isArray(raw.args) ? raw.args.map(String) : [],
        env: stringRecord(raw.env) ?? {},
        ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      });
    } else if (type === 'http' || type === 'streamable-http' || type === 'streamablehttp') {
      if (typeof raw.url !== 'string' || !/^https?:\/\//i.test(raw.url.trim())) {
        errors.push(`${name}: "url" must start with http:// or https://`);
        continue;
      }
      servers.push({
        name,
        key,
        transport: 'http',
        url: raw.url.trim(),
        headers: stringRecord(raw.headers) ?? {},
        ...(timeoutMs ? { timeoutMs } : {}),
      });
    } else {
      // SSE แบบเก่า (2024-11-05) ถูกแทนด้วย Streamable HTTP แล้ว
      errors.push(`${name}: transport "${type}" is not supported (use stdio or http)`);
      continue;
    }
    usedKeys.add(key);
  }
  return { servers, errors };
}
