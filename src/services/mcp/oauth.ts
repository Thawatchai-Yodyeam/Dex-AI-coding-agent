import type { Translation } from '../../utils/i18n';
import { tauriBridge, type McpOauthStatus } from '../tauriBridge';
import type { McpServerStatus } from './manager';

/**
 * ส่วนของการล็อกอิน MCP ที่อยู่ฝั่งหน้าจอ — ทุกอย่างที่แตะ token อยู่ใน lib.rs
 * webview รู้แค่ว่าล็อกอินแล้วหรือยัง จึงไม่มีทางอ่าน token ออกมาได้แม้หน้าเว็บจะถูกแทรกสคริปต์
 */

const ERROR_PREFIX = 'OAUTH_';
const CANCELLED = 'OAUTH_CANCELLED';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function isOauthCancelled(err: unknown): boolean {
  return errorText(err) === CANCELLED;
}

/** รหัสจาก Rust (`OAUTH_X: รายละเอียด`) → ข้อความตามภาษาที่เลือก error อื่นคืนตามเดิม */
export function describeOauthError(err: unknown, t: Translation): string {
  const text = errorText(err);
  if (!text.startsWith(ERROR_PREFIX)) return text;
  const separator = text.indexOf(':');
  const code = separator === -1 ? text : text.slice(0, separator);
  const detail = separator === -1 ? '' : text.slice(separator + 1).trim();
  const message = t.oauthErrors[code] ?? t.oauthErrorUnknown;
  return detail ? `${message} (${detail})` : message;
}

/** เปิดเบราว์เซอร์ให้ผู้ใช้ล็อกอิน */
export function signInToMcpServer(key: string, url: string, t: Translation, scope?: string): Promise<McpOauthStatus> {
  return tauriBridge.mcpOauthLogin(key, url, { success: t.oauthBrowserSuccess, failure: t.oauthBrowserFailure }, scope);
}

export function mcpStatusLabel(status: McpServerStatus, t: Translation): string {
  switch (status.state) {
    case 'ready':
      return t.mcpReady(status.tools.length);
    case 'starting':
      return t.mcpStarting;
    case 'auth':
      return t.mcpNeedsSignIn;
    case 'error':
      return t.mcpError;
  }
}

/** ชื่อโดเมนที่แสดงว่าล็อกอินกับใคร */
export function issuerHost(issuer: string | null): string | null {
  if (!issuer) return null;
  try {
    return new URL(issuer).host;
  } catch {
    return null;
  }
}
