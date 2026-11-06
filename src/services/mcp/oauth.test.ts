import { beforeEach, describe, expect, it, vi } from 'vitest';
import rustSource from '../../../src-tauri/src/lib.rs?raw';
import { translations } from '../../utils/i18n';
import { parseMcpConfig, type McpServerConfig } from './config';
import { McpManager } from './manager';
import { describeOauthError, issuerHost, isOauthCancelled, mcpStatusLabel, signInToMcpServer } from './oauth';

const bridge = vi.hoisted(() => ({
  mcpHttpRequest: vi.fn(),
  mcpOauthLogin: vi.fn(async () => ({ signed_in: true, expires_at: null, can_refresh: true, issuer: null, scope: null })),
}));
vi.mock('../tauriBridge', () => ({ tauriBridge: bridge }));

const th = translations.th;
const en = translations.en;

function oauthServer(extra: Record<string, unknown> = {}): McpServerConfig {
  return parseMcpConfig(JSON.stringify({ mcpServers: { srv: { type: 'http', url: 'https://mcp.example.com/mcp', auth: 'oauth', ...extra } } })).servers[0];
}

type Reply = { status: number; headers?: Record<string, string>; body?: string; auth_challenge?: unknown };

/** server ปลอมหลัง mcp_http_request — `gate` คืนคำตอบแทน server เมื่อยังไม่ได้รับอนุญาต */
function fakeRemote(gate: (message: any) => Reply | null = () => null) {
  const tools = [{ name: 'list', inputSchema: {} }];
  bridge.mcpHttpRequest.mockImplementation(async (_url: string, _headers: Record<string, string>, body: string) => {
    const message = JSON.parse(body);
    const blocked = gate(message);
    if (blocked) return { headers: {}, body: '', ...blocked };
    if (message.id === undefined) return { status: 202, headers: {}, body: '' };
    const result =
      message.method === 'initialize'
        ? { protocolVersion: '2025-06-18', serverInfo: { name: 'fake' }, capabilities: {} }
        : message.method === 'tools/list'
          ? { tools }
          : { content: [{ type: 'text', text: 'done' }] };
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) };
  });
}

const challenge = (error: string | null, scope: string | null = null) => ({ error, scope, resource_metadata: null });

async function connected(manager: McpManager, server: McpServerConfig, state: string) {
  manager.sync([server], '');
  await vi.waitFor(() => expect(manager.statuses()[0].state).toBe(state));
  return manager.statuses()[0];
}

beforeEach(() => vi.clearAllMocks());

describe('"auth" in the MCP config', () => {
  it('is read from http servers', () => {
    expect(oauthServer().auth).toBe('oauth');
    const parsed = parseMcpConfig(JSON.stringify({ mcpServers: { a: { type: 'http', url: 'https://x/mcp' } } }));
    expect(parsed.servers[0].auth).toBeUndefined();
  });

  it('rejects values it does not understand instead of connecting without a sign-in', () => {
    const parsed = parseMcpConfig(JSON.stringify({ mcpServers: { a: { type: 'http', url: 'https://x/mcp', auth: 'basic' } } }));
    expect(parsed.servers).toEqual([]);
    expect(parsed.errors[0]).toContain('"auth"');
  });
});

describe('HTTP transport with OAuth', () => {
  it('names the server and lets Rust add the token', async () => {
    fakeRemote();
    await connected(new McpManager(), oauthServer({ headers: { 'X-Team': 'a' } }), 'ready');
    for (const [, headers, , , oauthKey] of bridge.mcpHttpRequest.mock.calls) {
      expect(oauthKey).toBe('srv');
      expect(headers['X-Team']).toBe('a');
      expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('authorization');
    }
  });

  it('keeps servers without "auth" exactly as they were', async () => {
    fakeRemote();
    const [server] = parseMcpConfig(
      JSON.stringify({ mcpServers: { plain: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } } } })
    ).servers;
    await connected(new McpManager(), server, 'ready');
    const [, headers, , , oauthKey] = bridge.mcpHttpRequest.mock.calls[0];
    expect(headers.Authorization).toBe('Bearer ${TOKEN}');
    expect(oauthKey).toBeUndefined();
  });

  it('shows 401 as needing a sign-in, not as a failure', async () => {
    fakeRemote(() => ({ status: 401, auth_challenge: challenge('invalid_token') }));
    const manager = new McpManager();
    const status = await connected(manager, oauthServer(), 'auth');
    expect(status).toMatchObject({ state: 'auth', tools: [], oauthUrl: 'https://mcp.example.com/mcp' });
    expect(status.error).toBeUndefined();
    expect(manager.toolDefinitions()).toEqual([]);
  });

  it('connects after signing in and reconnecting', async () => {
    let signedIn = false;
    fakeRemote(() => (signedIn ? null : { status: 401 }));
    const manager = new McpManager();
    await connected(manager, oauthServer(), 'auth');
    signedIn = true;
    manager.restart('srv');
    await vi.waitFor(() => expect(manager.statuses()[0].state).toBe('ready'));
    expect(manager.toolDefinitions().map((d) => d.name)).toEqual(['mcp__srv__list']);
  });

  it('asks for a sign-in again when the login stops working mid-session', async () => {
    let revoked = false;
    fakeRemote((message) => (revoked && message.method === 'tools/call' ? { status: 401 } : null));
    const manager = new McpManager();
    await connected(manager, oauthServer(), 'ready');
    revoked = true;
    await expect(manager.callTool('mcp__srv__list', {})).rejects.toThrow(/sign-in/i);
    expect(manager.statuses()[0]).toMatchObject({ state: 'auth', tools: [] });
    expect(manager.toolDefinitions()).toEqual([]);
  });

  it('keeps working tools and records the scope on insufficient_scope', async () => {
    fakeRemote((message) => (message.method === 'tools/call' ? { status: 403, auth_challenge: challenge('insufficient_scope', 'files:write') } : null));
    const manager = new McpManager();
    await connected(manager, oauthServer(), 'ready');
    await expect(manager.callTool('mcp__srv__list', {})).rejects.toThrow('files:write');
    expect(manager.statuses()[0]).toMatchObject({ state: 'ready', needsMoreScope: true, requiredScope: 'files:write' });
    expect(manager.toolDefinitions()).toHaveLength(1);

    // เชื่อมต่อใหม่แล้วถือว่าเริ่มใหม่
    manager.restart('srv');
    await vi.waitFor(() => expect(manager.statuses()[0].state).toBe('ready'));
    expect(manager.statuses()[0].needsMoreScope).toBeUndefined();
  });

  it('treats other 403 responses as ordinary errors', async () => {
    fakeRemote((message) => (message.method === 'initialize' ? { status: 403, body: 'blocked by policy', auth_challenge: challenge('invalid_token') } : null));
    const status = await connected(new McpManager(), oauthServer(), 'error');
    expect(status.error).toContain('blocked by policy');
  });

  it('shows 401 from a server without "auth" as an error', async () => {
    fakeRemote(() => ({ status: 401, body: 'nope' }));
    const [server] = parseMcpConfig(JSON.stringify({ mcpServers: { plain: { type: 'http', url: 'https://x/mcp' } } })).servers;
    const status = await connected(new McpManager(), server, 'error');
    expect(status.error).toContain('HTTP 401');
    expect(status.oauthUrl).toBeUndefined();
  });

  it('reports a failed refresh as a connection problem and does not ask for a sign-in', async () => {
    bridge.mcpHttpRequest.mockRejectedValue('OAUTH_REFRESH_FAILED: HTTP 503');
    const status = await connected(new McpManager(), oauthServer(), 'error');
    expect(describeOauthError(status.error, en)).toBe(`${en.oauthErrors.OAUTH_REFRESH_FAILED} (HTTP 503)`);
  });

  it('does not let a late error replace the sign-in state', async () => {
    const manager = new McpManager();
    fakeRemote(() => ({ status: 401 }));
    await connected(manager, oauthServer(), 'auth');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(manager.statuses()[0].state).toBe('auth');
  });
});

describe('sign-in helpers', () => {
  it('has a message in both languages for every error code Rust can return', () => {
    const codes = [...rustSource.matchAll(/const OAUTH_ERR_\w+: &str = "(OAUTH_\w+)";/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(15);
    for (const code of codes) {
      expect(th.oauthErrors[code], code).toBeTruthy();
      expect(en.oauthErrors[code], code).toBeTruthy();
      expect(th.oauthErrors[code], code).not.toBe(en.oauthErrors[code]);
    }
    expect(Object.keys(th.oauthErrors).sort()).toEqual([...codes].sort());
    expect(Object.keys(en.oauthErrors).sort()).toEqual([...codes].sort());
  });

  it('translates codes and keeps the detail from the server', () => {
    expect(describeOauthError('OAUTH_TIMEOUT', th)).toBe(th.oauthErrors.OAUTH_TIMEOUT);
    expect(describeOauthError('OAUTH_DENIED: access_denied (no)', en)).toBe(`${en.oauthErrors.OAUTH_DENIED} (access_denied (no))`);
    expect(describeOauthError(new Error('OAUTH_STORE: locked'), en)).toBe(`${en.oauthErrors.OAUTH_STORE} (locked)`);
    expect(describeOauthError('OAUTH_FUTURE_CODE', en)).toBe(en.oauthErrorUnknown);
    // error อื่นคืนตามเดิม
    expect(describeOauthError('HTTP 500: oops', th)).toBe('HTTP 500: oops');
    expect(describeOauthError(new Error('plain'), th)).toBe('plain');
  });

  it('recognises a cancelled sign-in', () => {
    expect(isOauthCancelled('OAUTH_CANCELLED')).toBe(true);
    expect(isOauthCancelled(new Error('OAUTH_CANCELLED'))).toBe(true);
    expect(isOauthCancelled('OAUTH_TIMEOUT')).toBe(false);
  });

  it('sends the browser pages in the chosen language and passes the extra scope', async () => {
    await signInToMcpServer('srv', 'https://x/mcp', th, 'files:write');
    expect(bridge.mcpOauthLogin).toHaveBeenCalledWith(
      'srv',
      'https://x/mcp',
      { success: th.oauthBrowserSuccess, failure: th.oauthBrowserFailure },
      'files:write'
    );
    await signInToMcpServer('srv', 'https://x/mcp', en);
    expect(bridge.mcpOauthLogin).toHaveBeenLastCalledWith(
      'srv',
      'https://x/mcp',
      { success: en.oauthBrowserSuccess, failure: en.oauthBrowserFailure },
      undefined
    );
  });

  it('labels the sign-in state', () => {
    const status = { name: 's', key: 's', transport: 'http' as const, state: 'auth' as const, tools: [], toolInfo: [] };
    expect(mcpStatusLabel(status, th)).toBe(th.mcpNeedsSignIn);
    expect(mcpStatusLabel({ ...status, state: 'ready', tools: ['a'] }, en)).toBe(en.mcpReady(1));
    expect(mcpStatusLabel({ ...status, state: 'starting' }, en)).toBe(en.mcpStarting);
    expect(mcpStatusLabel({ ...status, state: 'error' }, en)).toBe(en.mcpError);
  });

  it('shows the host of the sign-in service', () => {
    expect(issuerHost('https://api.supabase.com')).toBe('api.supabase.com');
    expect(issuerHost('https://access.stripe.com/mcp')).toBe('access.stripe.com');
    expect(issuerHost('not a url')).toBeNull();
    expect(issuerHost(null)).toBeNull();
  });
});
