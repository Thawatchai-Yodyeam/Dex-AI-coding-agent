import { evaluate, type BrowserDriver } from '../browser/actions';
import { tauriBridge } from '../tauriBridge';

export const DOCX_ACTIONS = ['open', 'read', 'edit', 'save'] as const;
export type DocxAction = (typeof DOCX_ACTIONS)[number];

/** สถานะเอกสารที่เปิดอยู่ใน G-docx (ดู plugins/gdocx/js/api.js) */
export interface DocxInfo {
  /** พาธบนดิสก์ — null = ผู้ใช้เปิดเองจากในหน้า G-docx หรือยังเป็นเอกสารเปล่า */
  path: string | null;
  name: string;
  modified: boolean;
  pages: number;
  blocks: number;
  styles: string[];
  /** ไฟล์ที่สำรองต้นฉบับไปแล้วตั้งแต่เปิดเอกสารนี้ */
  backups: string[];
}

export interface DocxReadResult extends DocxInfo {
  content: string;
  next_offset: number | null;
}

const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 150;

/** เรียกฟังก์ชันของ GDocxApi ในหน้า — error ของหน้าตัดเหลือบรรทัดแรก (ไม่ส่ง stack ให้โมเดล) */
async function callApi<T>(driver: BrowserDriver, method: string, ...args: unknown[]): Promise<T> {
  const list = args.map((a) => JSON.stringify(a)).join(',');
  try {
    return (await evaluate(driver, `GDocxApi.${method}(${list})`)) as T;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    error.message = error.message.split('\n')[0].replace(/^Error: /, '');
    throw error;
  }
}

/**
 * หน้าที่เปิดอยู่เป็น G-docx ของ Dex จริงไหม — เทียบ origin เพราะเอกสารจะถูกส่งเข้าหน้านี้
 * หน้าเว็บอื่นจะตั้ง window.GDocxApi ขึ้นมาเองเพื่อรับเนื้อหาไฟล์ไม่ได้
 */
async function isEditorPage(driver: BrowserDriver, editorUrl: string): Promise<boolean> {
  const current = await driver.currentUrl().catch(() => null);
  if (!current) return false;
  try {
    if (new URL(current).origin !== new URL(editorUrl).origin) return false;
  } catch {
    return false;
  }
  return (await evaluate(driver, '!!(window.GDocxApi && GDocxApi.ready())').catch(() => false)) === true;
}

/** เอกสารที่เปิดอยู่ — null = pane ไม่ได้เปิด G-docx อยู่ */
export async function currentDocument(driver: BrowserDriver): Promise<DocxInfo | null> {
  const url = await tauriBridge.gdocxUrl();
  return (await isEditorPage(driver, url)) ? callApi<DocxInfo>(driver, 'info') : null;
}

async function ensureEditor(driver: BrowserDriver): Promise<void> {
  await driver.show?.();
  const url = await tauriBridge.gdocxUrl();
  if (await isEditorPage(driver, url)) return;
  const loadError = await driver.navigate(url);
  if (loadError) throw new Error(`Could not open G-docx: ${loadError}`);
  for (let waited = 0; waited < READY_TIMEOUT_MS; waited += READY_POLL_MS) {
    if (await isEditorPage(driver, url)) return;
    await driver.sleep(READY_POLL_MS);
  }
  throw new Error('G-docx did not finish loading');
}

export async function openDocument(driver: BrowserDriver, base64: string, name: string, path: string): Promise<DocxInfo> {
  await ensureEditor(driver);
  return callApi<DocxInfo>(driver, 'open', base64, name, path);
}

export function readDocument(driver: BrowserDriver, offset?: number, limit?: number): Promise<DocxReadResult> {
  return callApi<DocxReadResult>(driver, 'read', { offset, limit });
}

export function editDocument(driver: BrowserDriver, ops: unknown[]): Promise<DocxInfo & { results: unknown[] }> {
  return callApi(driver, 'edit', ops);
}

/** ไฟล์ .docx ของเอกสารปัจจุบันเป็น base64 */
export function exportDocument(driver: BrowserDriver): Promise<string> {
  return callApi<string>(driver, 'exportDocx');
}

export function markDocumentSaved(driver: BrowserDriver, path: string, name: string, backedUp: boolean): Promise<DocxInfo> {
  return callApi<DocxInfo>(driver, 'markSaved', path, name, backedUp);
}
