import { tauriBridge } from '../tauriBridge';
import type { ToolImage } from '../agent/types';
import { TOOL_IMAGES_KEY } from '../agent/types';
import { browserPane } from './pane';
import {
  PAGE_HOOK,
  FOCUS_REF,
  LOCATE_REF,
  PAGE_INFO,
  READ_CONSOLE,
  SELECT_OPTION,
  SNAPSHOT,
  VIEWPORT,
  callScript,
} from './pageScripts';

export const BROWSER_ACTIONS = [
  'navigate',
  'snapshot',
  'screenshot',
  'click',
  'type',
  'press',
  'scroll',
  'wait',
  'console',
  'evaluate',
] as const;
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

/** สิ่งที่ action ต้องใช้จาก pane — แยก interface ไว้ให้เทสต์ใส่ของปลอมได้ */
export interface BrowserDriver {
  /** เปิด URL — คืนข้อความ error ของการโหลด หรือ null */
  navigate(url: string): Promise<string | null>;
  cdp(method: string, params?: Record<string, unknown>): Promise<any>;
  /** URL ของหน้าที่เปิดอยู่ (null = ยังไม่ได้เปิด pane) */
  currentUrl(): Promise<string | null>;
  sleep(ms: number): Promise<void>;
  /** ให้ pane โผล่ขึ้นมา แม้ผู้ใช้จะซ่อนไว้ */
  show?(): Promise<void>;
}

export const paneDriver: BrowserDriver = {
  navigate: (url) => browserPane.navigate(url),
  cdp: (method, params) => tauriBridge.browserCdp(method, params),
  currentUrl: () => tauriBridge.browserUrl(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  show: () => browserPane.ensureOpen(),
};

const SNAPSHOT_MAX_CHARS = 15_000;
const EVALUATE_MAX_CHARS = 10_000;
const LOAD_TIMEOUT_MS = 15_000;
const MAX_WAIT_MS = 15_000;
/** หลังคลิก/กดปุ่ม รอให้หน้า (SPA) อัปเดตก่อนรายงานผล */
const SETTLE_MS = 400;
/** ด้านยาวสุดของ screenshot — Claude ย่อรูปที่ใหญ่กว่านี้ */
const MAX_SCREENSHOT_PX = 1568;

/** ผลของหนึ่ง action — `content` เป็นข้อความหลัก (snapshot/console/ผลของ script) */
export interface BrowserResult {
  url?: string;
  title?: string;
  content?: string;
  note?: string;
  error?: string;
  [TOOL_IMAGES_KEY]?: ToolImage[];
}

/** สัดส่วน px ของ screenshot ต่อ CSS px ล่าสุด — click {x, y} รับพิกัดจากรูป แล้วแปลงกลับ */
let screenshotScale = 1;

export async function evaluate(driver: BrowserDriver, expression: string): Promise<unknown> {
  const res = await driver.cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res?.exceptionDetails) {
    const ex = res.exceptionDetails;
    throw new Error(ex.exception?.description || ex.text || 'Script error');
  }
  return res?.result?.value;
}

async function evaluateJson<T>(driver: BrowserDriver, expression: string): Promise<T> {
  const raw = await evaluate(driver, expression);
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as T;
}

async function pageInfo(driver: BrowserDriver): Promise<{ url: string; title: string; ready: string }> {
  return evaluateJson(driver, PAGE_INFO);
}

/** รอจนหน้าโหลดเสร็จ — ระหว่างเปลี่ยนหน้า evaluate อาจล้ม (context ถูกทำลาย) จึงลองใหม่จนหมดเวลา */
async function waitForLoad(driver: BrowserDriver): Promise<{ url: string; title: string }> {
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  let last = { url: '', title: '', ready: '' };
  while (Date.now() < deadline) {
    try {
      last = await pageInfo(driver);
      if (last.ready === 'complete') break;
    } catch {
      // หน้ากำลังเปลี่ยน
    }
    await driver.sleep(200);
  }
  return { url: last.url, title: last.title };
}

/** หลังโต้ตอบ: รอให้หน้าอัปเดต และถ้ากดแล้วเปลี่ยนหน้า ก็รอจนโหลดเสร็จ */
async function settle(driver: BrowserDriver): Promise<BrowserResult> {
  await driver.sleep(SETTLE_MS);
  return waitForLoad(driver);
}

const text = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const number = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** คลิกซ้ายแบบเดียวกับ Puppeteer — ต้องมี `buttons` ด้วย ไม่งั้นลิงก์ target=_blank ไม่เปิด */
async function mouseClick(driver: BrowserDriver, x: number, y: number) {
  await driver.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await driver.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await driver.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

interface KeyInfo {
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED_KEYS: Record<string, KeyInfo> = {
  enter: { code: 'Enter', keyCode: 13, text: '\r' },
  tab: { code: 'Tab', keyCode: 9 },
  escape: { code: 'Escape', keyCode: 27 },
  backspace: { code: 'Backspace', keyCode: 8 },
  delete: { code: 'Delete', keyCode: 46 },
  space: { code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { code: 'ArrowUp', keyCode: 38 },
  arrowdown: { code: 'ArrowDown', keyCode: 40 },
  arrowleft: { code: 'ArrowLeft', keyCode: 37 },
  arrowright: { code: 'ArrowRight', keyCode: 39 },
  home: { code: 'Home', keyCode: 36 },
  end: { code: 'End', keyCode: 35 },
  pageup: { code: 'PageUp', keyCode: 33 },
  pagedown: { code: 'PageDown', keyCode: 34 },
};
const KEY_ALIASES: Record<string, string> = { esc: 'escape', return: 'enter', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', ' ': 'space' };
const MODIFIERS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, shift: 8 };

/** `Enter`, `Control+a`, `Shift+Tab` → event ของ DevTools protocol */
export function keyEvents(spec: string): Record<string, unknown>[] {
  const parts = spec.split('+').map((p) => p.trim()).filter(Boolean);
  const main = parts.pop() ?? '';
  let modifiers = 0;
  for (const mod of parts) {
    const bit = MODIFIERS[mod.toLowerCase()];
    if (bit === undefined) throw new Error(`Unknown modifier "${mod}"`);
    modifiers |= bit;
  }
  const lower = main.toLowerCase();
  let info = NAMED_KEYS[KEY_ALIASES[lower] ?? lower];
  let key = info?.code.replace(/^Space$/, ' ');
  if (!info) {
    if ([...main].length !== 1) throw new Error(`Unknown key "${main}". Use a single character or Enter, Tab, Escape, Backspace, Delete, Space, Arrow keys, Home, End, PageUp, PageDown.`);
    const upper = main.toUpperCase();
    const isLetter = /^[A-Z]$/.test(upper);
    info = { code: isLetter ? `Key${upper}` : /^\d$/.test(main) ? `Digit${main}` : '', keyCode: upper.charCodeAt(0), text: main };
    key = main;
  }
  // กดคู่กับ Ctrl/Alt/Meta ไม่ใช่การพิมพ์ตัวอักษร
  const typed = info.text && !(modifiers & (1 | 2 | 4)) ? info.text : undefined;
  const base = { key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode, modifiers };
  return [
    { ...base, type: typed ? 'keyDown' : 'rawKeyDown', ...(typed ? { text: typed, unmodifiedText: typed } : {}) },
    { ...base, type: 'keyUp' },
  ];
}

function formatConsole(entries: { level: string; text: string }[]): string {
  if (entries.length === 0) return '(no new console messages)';
  return entries.map((e) => `[${e.level}] ${e.text}`).join('\n');
}

/**
 * ทำ action หนึ่งอย่างใน browser pane — ไม่ตรวจสิทธิ์ (tools.ts ตรวจก่อนเรียก)
 * error ที่ผู้ใช้/โมเดลแก้ได้ (ref หาย, คีย์ผิด) คืนเป็น `{ error }` ส่วนที่เหลือ throw
 */
export async function runBrowserAction(
  action: BrowserAction,
  args: Record<string, any>,
  driver: BrowserDriver = paneDriver
): Promise<BrowserResult> {
  switch (action) {
    case 'navigate': {
      const loadError = await driver.navigate(text(args.url));
      if (loadError) {
        return {
          error: `Could not load ${text(args.url)}: ${loadError}${/REFUSED|CONNECTION/i.test(loadError) ? ' — is the server running?' : ''}`,
        };
      }
      const page = await waitForLoad(driver);
      return { ...page, note: 'Page loaded. Call snapshot to read it, or screenshot to see it.' };
    }

    case 'snapshot': {
      const snap = await evaluateJson<{ url: string; title: string; refs: number; scroll: string; text: string }>(
        driver,
        callScript(SNAPSHOT, SNAPSHOT_MAX_CHARS)
      );
      return {
        url: snap.url,
        title: snap.title,
        content: snap.text || '(the page has no visible text)',
        note: `${snap.refs} interactive elements; scrolled ${snap.scroll}. Use refs with click/type until the page changes.`,
      };
    }

    case 'screenshot': {
      const view = await evaluateJson<{ width: number; height: number; dpr: number; scrollX: number; scrollY: number }>(driver, VIEWPORT);
      const dpr = view.dpr || 1;
      // รูปยาวเกิน MAX_SCREENSHOT_PX โมเดลจะถูกย่อรูปให้ (พิกัดที่ตอบมาจะเพี้ยน) จึงย่อเองให้รู้สเกลแน่นอน
      const scale = Math.min(dpr, MAX_SCREENSHOT_PX / view.width, MAX_SCREENSHOT_PX / view.height);
      const shot = await driver.cdp('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 70,
        ...(scale < dpr
          ? { clip: { x: view.scrollX, y: view.scrollY, width: view.width, height: view.height, scale: scale / dpr } }
          : {}),
      });
      screenshotScale = scale;
      const page = await pageInfo(driver);
      const width = Math.round(view.width * scale);
      const height = Math.round(view.height * scale);
      return {
        url: page.url,
        title: page.title,
        note: `Screenshot of the visible area, ${width}x${height} px. Click a spot with click {x, y} in these image pixels.`,
        [TOOL_IMAGES_KEY]: [{ mediaType: 'image/jpeg', data: shot.data }],
      };
    }

    case 'click': {
      let x = number(args.x);
      let y = number(args.y);
      let note: string | undefined;
      if (args.ref) {
        const target = await evaluateJson<{ x: number; y: number; covered: string | null; error?: string }>(
          driver,
          callScript(LOCATE_REF, text(args.ref))
        );
        if (target.error) return { error: target.error };
        ({ x, y } = target);
        if (target.covered) note = `Another element (${target.covered}) was on top of ${args.ref}; the click may have hit it instead.`;
      } else if (x !== undefined && y !== undefined) {
        x /= screenshotScale;
        y /= screenshotScale;
      } else {
        return { error: 'click needs a ref from snapshot, or x and y from a screenshot' };
      }
      await mouseClick(driver, x!, y!);
      return { ...(await settle(driver)), ...(note ? { note } : {}) };
    }

    case 'type': {
      const ref = text(args.ref);
      if (!ref) return { error: 'type needs a ref from snapshot' };
      const value = text(args.text);
      const clear = args.clear !== false && args.clear !== 'false';
      const focus = await evaluateJson<{ focused?: boolean; select?: boolean; error?: string }>(
        driver,
        callScript(FOCUS_REF, [ref, clear])
      );
      if (focus.error) return { error: focus.error };
      if (focus.select) {
        const picked = await evaluateJson<{ selected?: string; error?: string }>(driver, callScript(SELECT_OPTION, [ref, value]));
        if (picked.error) return { error: picked.error };
        return { ...(await settle(driver)), note: `Selected "${picked.selected}".` };
      }
      if (!focus.focused) return { error: `${ref} cannot take keyboard input` };
      if (value) await driver.cdp('Input.insertText', { text: value });
      else if (clear) for (const event of keyEvents('Backspace')) await driver.cdp('Input.dispatchKeyEvent', event);
      if (args.submit === true || args.submit === 'true') {
        for (const event of keyEvents('Enter')) await driver.cdp('Input.dispatchKeyEvent', event);
      }
      return settle(driver);
    }

    case 'press': {
      let events: Record<string, unknown>[];
      try {
        events = keyEvents(text(args.key));
      } catch (err: any) {
        return { error: err.message };
      }
      for (const event of events) await driver.cdp('Input.dispatchKeyEvent', event);
      return settle(driver);
    }

    case 'scroll': {
      if (args.ref) {
        const target = await evaluateJson<{ error?: string }>(driver, callScript(LOCATE_REF, text(args.ref)));
        if (target.error) return { error: target.error };
      } else {
        const direction = text(args.direction || 'down').toLowerCase();
        const amount = number(args.amount);
        const sign = direction === 'up' || direction === 'left' ? -1 : 1;
        const horizontal = direction === 'left' || direction === 'right';
        await evaluate(
          driver,
          `(() => { const d = ${sign} * (${amount ?? 'Math.round(innerHeight * 0.8)'}); scrollBy(${horizontal ? 'd, 0' : '0, d'}); })()`
        );
      }
      const pos = await evaluateJson<{ y: number; max: number }>(
        driver,
        `JSON.stringify({ y: Math.round(scrollY), max: Math.max(0, document.documentElement.scrollHeight - innerHeight) })`
      );
      return { note: `Scrolled to ${pos.y} of ${pos.max}px. Take a new snapshot to read what is visible now.` };
    }

    case 'wait': {
      const wanted = text(args.text).trim();
      const ms = Math.min(Math.max(number(args.ms) ?? (wanted ? 5000 : 1000), 0), MAX_WAIT_MS);
      if (!wanted) {
        await driver.sleep(ms);
        return pageInfo(driver).then(({ url, title }) => ({ url, title }));
      }
      const deadline = Date.now() + ms;
      do {
        try {
          if (await evaluate(driver, `!!document.body && document.body.innerText.includes(${JSON.stringify(wanted)})`)) {
            return { ...(await pageInfo(driver).then(({ url, title }) => ({ url, title }))), note: `"${wanted}" is on the page.` };
          }
        } catch {
          // หน้ากำลังเปลี่ยน
        }
        await driver.sleep(250);
      } while (Date.now() < deadline);
      return { error: `"${wanted}" did not appear within ${Math.round(ms / 1000)}s` };
    }

    case 'console': {
      const raw = await evaluate(driver, READ_CONSOLE);
      if (raw == null) {
        // หน้านี้เปิดก่อนติดตั้งตัวเก็บ log — เริ่มเก็บตั้งแต่ตอนนี้
        await evaluate(driver, PAGE_HOOK);
        return { content: '(console capture started now — messages from before this point were not recorded)' };
      }
      return { content: formatConsole(JSON.parse(text(raw))) };
    }

    case 'evaluate': {
      const expression = text(args.expression ?? args.script);
      if (!expression.trim()) return { error: 'evaluate needs an expression' };
      const res = await driver.cdp('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        replMode: true,
        timeout: 10_000,
      });
      if (res?.exceptionDetails) {
        const ex = res.exceptionDetails;
        return { error: ex.exception?.description || ex.text || 'Script error' };
      }
      const value = res?.result?.value;
      const shown =
        res?.result?.type === 'undefined' ? 'undefined' : typeof value === 'string' ? value : JSON.stringify(value ?? res?.result?.description ?? null);
      return {
        content:
          shown.length > EVALUATE_MAX_CHARS ? `${shown.slice(0, EVALUATE_MAX_CHARS)}\n… [${shown.length - EVALUATE_MAX_CHARS} more characters]` : shown,
      };
    }
  }
}
