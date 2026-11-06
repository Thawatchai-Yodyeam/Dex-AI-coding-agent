import type { McpProvider } from '../agent/AgentService';
import { MCP_TOOL_PREFIX } from '../agent/tools';
import type { ToolDefinition } from '../agent/types';
import { HttpTransport, McpClient, StdioTransport, type McpTool, type McpTransport } from './client';
import type { McpServerConfig } from './config';
import { estimateToolTokens } from './toolUsage';

export interface McpToolInfo {
  /** ชื่อตามที่ server ประกาศ — ชื่อนี้ที่เก็บใน disabledTools */
  name: string;
  description: string;
  enabled: boolean;
  /** ขนาด definition โดยประมาณที่ส่งให้โมเดลในทุกคำขอ (ถ้าเปิดอยู่) */
  tokens: number;
}

export interface McpServerStatus {
  name: string;
  key: string;
  transport: McpServerConfig['transport'];
  state: 'starting' | 'ready' | 'error';
  /** tool ที่ส่งให้โมเดลจริง (ไม่รวมตัวที่ผู้ใช้ปิด) */
  tools: string[];
  /** tool ทุกตัวที่ server ประกาศ รวมตัวที่ผู้ใช้ปิด */
  toolInfo: McpToolInfo[];
  error?: string;
}

interface Entry {
  config: McpServerConfig;
  /** เปลี่ยน = ต้องเปิด server ใหม่ */
  signature: string;
  client?: McpClient;
  tools: McpTool[];
  status: McpServerStatus;
}

/** ชื่อ tool ต้องเป็น [a-zA-Z0-9_-] ไม่เกิน 64 ตัว (เพดานร่วมของ Claude/OpenAI/Gemini) */
export function mcpToolName(serverKey: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverKey}__${toolName.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64);
}

/** input schema ของ MCP → schema ที่ทุกค่ายรับ (ต้องเป็น object และไม่มี $schema) */
export function sanitizeSchema(schema: unknown): Record<string, unknown> {
  const s: Record<string, unknown> = schema && typeof schema === 'object' && !Array.isArray(schema) ? { ...(schema as object) } : {};
  delete s.$schema;
  if (s.type !== undefined && s.type !== 'object') return { type: 'object', properties: {} };
  return { ...s, type: 'object', properties: s.properties && typeof s.properties === 'object' ? s.properties : {} };
}

/** ผลของ tools/call → ข้อความเดียวที่ส่งให้โมเดลได้ทุกค่าย (รูป/เสียงบอกเป็นป้ายแทน) */
export function formatToolResult(result: any): string {
  const parts = ((result?.content as any[]) ?? []).map((c) => {
    switch (c?.type) {
      case 'text':
        return String(c.text ?? '');
      case 'image':
        return `[image ${c.mimeType ?? ''} omitted]`;
      case 'audio':
        return `[audio ${c.mimeType ?? ''} omitted]`;
      case 'resource':
        return c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`;
      case 'resource_link':
        return `[resource ${c.uri ?? ''}${c.name ? ` (${c.name})` : ''}]`;
      default:
        return JSON.stringify(c);
    }
  });
  if (parts.length === 0 && result?.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return parts.join('\n');
}

/** disabledTools ไม่อยู่ในนี้: เปิด/ปิด tool รายตัวไม่ต้องตัดการเชื่อมต่อ (งานที่ค้างอยู่ใน server ไม่ควรหาย) */
function signatureOf(config: McpServerConfig, cwd: string): string {
  const { disabledTools: _disabledTools, ...connection } = config;
  return JSON.stringify({ ...connection, cwd: config.transport === 'stdio' ? (config.cwd ?? cwd) : undefined });
}

const isToolEnabled = (config: McpServerConfig, toolName: string) => !config.disabledTools?.includes(toolName);

/** definition ที่ส่งให้โมเดลจริง — ขนาดที่แสดงในหน้า Customizations คำนวณจากตัวนี้ด้วย ตัวเลขจึงไม่คลาดจากของจริง */
function toolDefinition(config: McpServerConfig, tool: McpTool): ToolDefinition {
  return {
    name: mcpToolName(config.key, tool.name),
    description: `[MCP server "${config.name}"] ${tool.description ?? tool.annotations?.title ?? tool.name}`.slice(0, 1024),
    parameters: sanitizeSchema(tool.inputSchema),
  };
}

/**
 * เปิด/ปิด MCP server ตาม settings และให้ AgentService ใช้ tool ของทุก server ที่พร้อม
 * server ที่ล่มจะแสดงสถานะ error พร้อมเหตุผล (stderr ท้าย ๆ) ในหน้าตั้งค่า
 */
export class McpManager implements McpProvider {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private cwd = '';

  constructor(private readonly makeTransport: (config: McpServerConfig, cwd: string) => McpTransport = defaultTransport) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  statuses(): McpServerStatus[] {
    return [...this.entries.values()].map((e) => e.status);
  }

  /** ให้ server ที่รันอยู่ตรงกับ config ล่าสุด — ตัวที่ไม่เปลี่ยนไม่ถูกแตะ */
  sync(servers: McpServerConfig[], cwd: string) {
    this.cwd = cwd;
    const wanted = new Map(servers.map((s) => [s.key, s]));
    for (const [key, entry] of this.entries) {
      const next = wanted.get(key);
      if (!next || signatureOf(next, cwd) !== entry.signature) {
        this.entries.delete(key);
        void entry.client?.close();
      } else {
        entry.config = next;
        if (entry.status.state === 'ready') this.publishTools(entry);
      }
    }
    for (const config of servers) if (!this.entries.has(config.key)) this.start(config);
    this.emit();
  }

  restart(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    void entry.client?.close();
    this.start(entry.config);
    this.emit();
  }

  private start(config: McpServerConfig) {
    const entry: Entry = {
      config,
      signature: signatureOf(config, this.cwd),
      tools: [],
      status: { name: config.name, key: config.key, transport: config.transport, state: 'starting', tools: [], toolInfo: [] },
    };
    this.entries.set(config.key, entry);
    void this.connect(entry);
  }

  private isCurrent(entry: Entry) {
    return this.entries.get(entry.config.key) === entry;
  }

  private fail(entry: Entry, reason: string) {
    if (!this.isCurrent(entry)) return;
    entry.tools = [];
    entry.status = { ...entry.status, state: 'error', tools: [], toolInfo: [], error: reason };
    this.emit();
  }

  private async connect(entry: Entry) {
    const transport = this.makeTransport(entry.config, this.cwd);
    const client = new McpClient(transport, entry.config.timeoutMs ?? 60_000);
    entry.client = client;
    client.onClose = (reason) => this.fail(entry, reason);
    try {
      if (transport instanceof StdioTransport) await transport.start();
      await client.initialize();
      client.onToolsChanged = () => void this.refreshTools(entry).catch((err) => this.fail(entry, String(err?.message ?? err)));
      await this.refreshTools(entry);
    } catch (err: any) {
      this.fail(entry, err?.message || String(err));
      void client.close();
    }
  }

  private async refreshTools(entry: Entry) {
    const tools = await entry.client!.listTools();
    if (!this.isCurrent(entry)) return;
    entry.tools = tools;
    this.publishTools(entry);
    this.emit();
  }

  /** อัปเดตสถานะให้ตรงกับ tool ล่าสุดและรายการที่ปิดไว้ — ผู้เรียกต้อง emit เอง */
  private publishTools(entry: Entry) {
    const { config, tools } = entry;
    entry.status = {
      ...entry.status,
      state: 'ready',
      tools: tools.filter((tool) => isToolEnabled(config, tool.name)).map((tool) => tool.name),
      toolInfo: tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? tool.annotations?.title ?? '',
        enabled: isToolEnabled(config, tool.name),
        tokens: estimateToolTokens(toolDefinition(config, tool)),
      })),
      error: undefined,
    };
  }

  toolDefinitions(): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const entry of this.entries.values()) {
      if (entry.status.state !== 'ready') continue;
      for (const tool of entry.tools) {
        if (isToolEnabled(entry.config, tool.name)) defs.push(toolDefinition(entry.config, tool));
      }
    }
    return defs;
  }

  /** หาเฉพาะ tool ที่เปิดอยู่ — ชื่อเต็มของสองตัวอาจชนกัน (a.b กับ a_b) ตัวที่ปิดจึงต้องไม่บังตัวที่เปิด */
  private resolve(name: string): { entry: Entry; tool: McpTool } | null {
    for (const entry of this.entries.values()) {
      const tool = entry.tools.find((t) => isToolEnabled(entry.config, t.name) && mcpToolName(entry.config.key, t.name) === name);
      if (tool) return { entry, tool };
    }
    return null;
  }

  isDisabled(name: string): boolean {
    if (this.resolve(name)) return false;
    return [...this.entries.values()].some((entry) => entry.tools.some((t) => mcpToolName(entry.config.key, t.name) === name));
  }

  isReadOnly(name: string): boolean {
    return this.resolve(name)?.tool.annotations?.readOnlyHint === true;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
    const hit = this.resolve(name);
    if (!hit?.entry.client || hit.entry.status.state !== 'ready') throw new Error(`MCP tool ${name} is not available`);
    // tool อย่าง build/deploy อาจนาน — ให้เวลามากกว่า request ทั่วไป
    const result = await hit.entry.client.callTool(hit.tool.name, args, hit.entry.config.timeoutMs ?? 300_000, signal);
    return { text: formatToolResult(result), isError: result?.isError === true };
  }
}

function defaultTransport(config: McpServerConfig, cwd: string): McpTransport {
  return config.transport === 'stdio'
    ? new StdioTransport(`mcp-${config.key}-${Date.now().toString(36)}`, config, cwd)
    : new HttpTransport(config);
}

/** ตัวเดียวทั้งแอป */
export const mcpManager = new McpManager();
