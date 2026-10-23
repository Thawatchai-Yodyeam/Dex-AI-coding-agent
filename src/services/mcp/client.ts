import { tauriBridge } from '../tauriBridge';
import { tryParseJson } from '../agent/sse';
import type { McpServerConfig } from './config';

/** เวอร์ชันโปรโตคอลที่ขอตอน initialize (server ตอบเวอร์ชันที่ตัวเองใช้กลับมา) */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

/** ช่องทางส่ง/รับข้อความ JSON-RPC — ข้อความขาเข้าทุกชนิด (รวม response ของ http) ออกทาง onMessage */
export interface McpTransport {
  send(message: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  onMessage?: (message: unknown) => void;
  /** การเชื่อมต่อหลุด (process จบ ฯลฯ) */
  onClose?: (reason: string) => void;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message);
    this.name = 'McpError';
  }
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** client JSON-RPC 2.0 ของ MCP: initialize → tools/list → tools/call */
export class McpClient {
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  instructions?: string;
  serverName?: string;
  onToolsChanged?: () => void;
  onClose?: (reason: string) => void;

  constructor(
    private readonly transport: McpTransport,
    private readonly timeoutMs = 60_000
  ) {
    transport.onMessage = (m) => this.handle(m);
    transport.onClose = (reason) => {
      this.failAll(reason);
      this.onClose?.(reason);
    };
  }

  /**
   * ส่ง request แล้วรอคำตอบ — `signal` ถูกยกเลิก (ผู้ใช้กดหยุด) = เลิกรอทันทีและบอก server ด้วย
   * notifications/cancelled ตามสเปก ให้ server หยุดงานที่ค้างอยู่ได้
   */
  request(method: string, params?: Record<string, unknown>, timeoutMs = this.timeoutMs, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) return Promise.reject(new McpError(`${method} cancelled`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const stopListening = () => signal?.removeEventListener('abort', onAbort);
      const fail = (err: Error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        stopListening();
        reject(err);
      };
      const onAbort = () => {
        void this.notify('notifications/cancelled', { requestId: id, reason: 'Cancelled by the user' }).catch(() => {});
        fail(new McpError(`${method} cancelled`));
      };
      const timer = setTimeout(() => fail(new McpError(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          stopListening();
          resolve(value);
        },
        reject: (err) => {
          stopListening();
          reject(err);
        },
        timer,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.transport
        .send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })
        .catch((err) => fail(err instanceof Error ? err : new McpError(String(err))));
    });
  }

  notify(method: string, params?: Record<string, unknown>): Promise<void> {
    return this.transport.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  private handle(raw: unknown) {
    if (Array.isArray(raw)) {
      raw.forEach((m) => this.handle(m));
      return;
    }
    const msg = raw as Record<string, any> | null;
    if (!msg || typeof msg !== 'object') return;
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && !('method' in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new McpError(msg.error.message || 'MCP error', msg.error.code));
      else p.resolve(msg.result);
      return;
    }
    if (hasId && typeof msg.method === 'string') {
      // server ถามกลับ: ตอบ ping ได้ ที่เหลือ (sampling, roots, elicitation) ยังไม่รองรับ
      const reply =
        msg.method === 'ping'
          ? { result: {} }
          : { error: { code: -32601, message: `Method not supported by Dex: ${msg.method}` } };
      void this.transport.send({ jsonrpc: '2.0', id: msg.id, ...reply }).catch(() => {});
      return;
    }
    if (msg.method === 'notifications/tools/list_changed') this.onToolsChanged?.();
  }

  private failAll(reason: string) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new McpError(reason));
    }
    this.pending.clear();
  }

  async initialize(): Promise<void> {
    const result = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dex-agent', version: '0.1.0' },
    });
    this.instructions = typeof result?.instructions === 'string' ? result.instructions : undefined;
    this.serverName = result?.serverInfo?.name;
    await this.notify('notifications/initialized');
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    // กัน server ที่ส่ง cursor วนไม่จบ
    for (let page = 0; page < 20; page++) {
      const res = await this.request('tools/list', cursor ? { cursor } : undefined);
      tools.push(...((res?.tools as McpTool[]) ?? []).filter((t) => t && typeof t.name === 'string'));
      cursor = typeof res?.nextCursor === 'string' && res.nextCursor ? res.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<any> {
    return this.request('tools/call', { name, arguments: args }, timeoutMs, signal);
  }

  async close(): Promise<void> {
    this.failAll('MCP connection closed');
    await this.transport.close().catch(() => {});
  }
}

// ---------- stdio: process ที่ Rust เปิดให้ ข้อความมาทาง Tauri event ----------

const stdioTransports = new Map<string, StdioTransport>();
let listening: Promise<void> | null = null;

/** listener ชุดเดียวทั้งแอป แล้วแจกตาม id */
function ensureStdioListeners(): Promise<void> {
  listening ??= Promise.all([
    tauriBridge.onMcpEvent('mcp-message', ({ id, text }) => stdioTransports.get(id)?.receive(text)),
    tauriBridge.onMcpEvent('mcp-stderr', ({ id, text }) => stdioTransports.get(id)?.stderrLine(text)),
    tauriBridge.onMcpEvent('mcp-exit', ({ id, text }) => stdioTransports.get(id)?.exited(text)),
  ]).then(() => undefined);
  return listening;
}

const STDERR_TAIL_LINES = 8;

export class StdioTransport implements McpTransport {
  onMessage?: (message: unknown) => void;
  onClose?: (reason: string) => void;
  private stderr: string[] = [];

  constructor(
    private readonly id: string,
    private readonly config: McpServerConfig,
    private readonly cwd?: string
  ) {}

  async start(): Promise<void> {
    await ensureStdioListeners();
    stdioTransports.set(this.id, this);
    try {
      await tauriBridge.mcpStart(this.id, this.config.command!, this.config.args ?? [], this.config.env ?? {}, this.config.cwd ?? this.cwd);
    } catch (err) {
      stdioTransports.delete(this.id);
      throw err;
    }
  }

  receive(line: string) {
    // server บางตัวพิมพ์ log ลง stdout — ข้ามบรรทัดที่ไม่ใช่ JSON
    const msg = tryParseJson(line);
    if (msg && typeof msg === 'object') this.onMessage?.(msg);
  }

  stderrLine(line: string) {
    this.stderr.push(line);
    if (this.stderr.length > STDERR_TAIL_LINES) this.stderr.shift();
  }

  exited(code: string) {
    stdioTransports.delete(this.id);
    const tail = this.stderr.length ? `\n${this.stderr.join('\n')}` : '';
    this.onClose?.(`Server process exited (code ${code})${tail}`);
  }

  send(message: Record<string, unknown>): Promise<void> {
    return tauriBridge.mcpSend(this.id, JSON.stringify(message));
  }

  async close(): Promise<void> {
    stdioTransports.delete(this.id);
    await tauriBridge.mcpStop(this.id);
  }
}

// ---------- Streamable HTTP: POST หนึ่งครั้งต่อข้อความ response เป็น JSON หรือ SSE ----------

/** แยก event ของ SSE ที่ได้มาทั้งก้อน — `data:` หลายบรรทัดใน event เดียวต่อกันด้วย \n ตามสเปก */
export function parseSseMessages(body: string): unknown[] {
  const out: unknown[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    const msg = data ? tryParseJson(data) : null;
    if (msg) out.push(msg);
  }
  return out;
}

export class HttpTransport implements McpTransport {
  onMessage?: (message: unknown) => void;
  onClose?: (reason: string) => void;
  private sessionId?: string;
  private protocolVersion?: string;

  constructor(private readonly config: McpServerConfig) {}

  async send(message: Record<string, unknown>): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.config.headers ?? {}),
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;

    const res = await tauriBridge.mcpHttpRequest(this.config.url!, headers, JSON.stringify(message), this.config.timeoutMs);
    if (res.headers['mcp-session-id']) this.sessionId = res.headers['mcp-session-id'];
    if (res.status === 202 || res.status === 204) return;
    if (res.status >= 400) {
      const reason = `HTTP ${res.status}: ${res.body.slice(0, 300)}`;
      // request ที่รอคำตอบต้องรู้ทันที ไม่งั้นรอจน timeout
      if (message.id !== undefined) this.onMessage?.({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: reason } });
      return;
    }
    const contentType = res.headers['content-type'] ?? '';
    const messages = contentType.includes('text/event-stream') ? parseSseMessages(res.body) : [tryParseJson(res.body)].filter(Boolean);
    for (const msg of messages) {
      const version = (msg as any)?.result?.protocolVersion;
      if (message.method === 'initialize' && typeof version === 'string') this.protocolVersion = version;
      this.onMessage?.(msg);
    }
  }

  async close(): Promise<void> {
    this.sessionId = undefined;
  }
}
