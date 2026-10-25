import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../tauriBridge', () => ({ tauriBridge: {} }));

import { TOOL_IMAGES_KEY } from '../agent/types';
import { keyEvents, runBrowserAction, type BrowserDriver } from './actions';
import { PAGE_HOOK, FOCUS_REF, LOCATE_REF, PAGE_INFO, READ_CONSOLE, SELECT_OPTION, SNAPSHOT, VIEWPORT } from './pageScripts';

type Evaluator = (expression: string) => unknown;

/** driver ปลอม: ตอบ Runtime.evaluate ตามสคริปต์ที่ถูกเรียก และเก็บทุก call ไว้ตรวจ — sleep เลื่อนนาฬิกาปลอม */
function fakeDriver(evaluate: Evaluator, loadError: string | null = null) {
  const calls: { method: string; params: any }[] = [];
  const driver: BrowserDriver = {
    navigate: vi.fn(async () => loadError),
    currentUrl: async () => 'http://localhost:5173/',
    sleep: async (ms) => {
      vi.advanceTimersByTime(ms);
    },
    cdp: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        const value = evaluate(params.expression as string);
        if (value instanceof Error) return { exceptionDetails: { exception: { description: value.message } } };
        return value === undefined ? { result: { type: 'undefined' } } : { result: { type: typeof value, value } };
      }
      if (method === 'Page.captureScreenshot') return { data: 'SHOT' };
      return {};
    },
  };
  const of = (method: string) => calls.filter((c) => c.method === method).map((c) => c.params);
  return { driver, calls, of };
}

const page = JSON.stringify({ url: 'http://localhost:5173/', title: 'My App', ready: 'complete' });
/** ตอบสคริปต์พื้นฐาน แล้วให้แต่ละเทสต์ตอบสคริปต์ของตัวเองเพิ่ม */
const scripted =
  (extra: Evaluator = () => undefined): Evaluator =>
  (expr) => {
    const own = extra(expr);
    if (own !== undefined) return own;
    if (expr === PAGE_INFO) return page;
    return undefined;
  };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('navigate', () => {
  it('waits for the page to finish loading', async () => {
    let polls = 0;
    const { driver } = fakeDriver((expr) =>
      expr === PAGE_INFO ? JSON.stringify({ url: 'http://localhost:5173/', title: 'My App', ready: ++polls < 3 ? 'loading' : 'complete' }) : undefined
    );
    const res = await runBrowserAction('navigate', { url: 'http://localhost:5173/' }, driver);
    expect(driver.navigate).toHaveBeenCalledWith('http://localhost:5173/');
    expect(res).toMatchObject({ url: 'http://localhost:5173/', title: 'My App' });
    expect(polls).toBe(3);
  });

  it('explains connection errors', async () => {
    const { driver } = fakeDriver(scripted(), 'net::ERR_CONNECTION_REFUSED');
    const res = await runBrowserAction('navigate', { url: 'http://localhost:5173/' }, driver);
    expect(res.error).toMatch(/ERR_CONNECTION_REFUSED — is the server running\?/);
  });
});

describe('snapshot', () => {
  it('returns the page outline and ref count', async () => {
    const { driver } = fakeDriver((expr) =>
      expr.startsWith(SNAPSHOT)
        ? JSON.stringify({ url: 'u', title: 'T', refs: 2, scroll: '0 of 400px', text: '# Home\n[e1] button "Save"' })
        : undefined
    );
    const res = await runBrowserAction('snapshot', {}, driver);
    expect(res.content).toBe('# Home\n[e1] button "Save"');
    expect(res.note).toContain('2 interactive elements');
  });
});

describe('click', () => {
  it('clicks the middle of a ref with real mouse events', async () => {
    const { driver, of } = fakeDriver(
      scripted((expr) => (expr.startsWith(LOCATE_REF) ? JSON.stringify({ x: 120, y: 40, covered: 'div#modal "Cookies"' }) : undefined))
    );
    const res = await runBrowserAction('click', { ref: 'e3' }, driver);
    expect(of('Input.dispatchMouseEvent').map((p) => [p.type, p.x, p.y])).toEqual([
      ['mouseMoved', 120, 40],
      ['mousePressed', 120, 40],
      ['mouseReleased', 120, 40],
    ]);
    expect(res).toMatchObject({ title: 'My App', note: expect.stringContaining('div#modal') });
  });

  it('passes through a missing ref', async () => {
    const { driver, of } = fakeDriver(scripted((expr) => (expr.startsWith(LOCATE_REF) ? JSON.stringify({ error: 'No element e9' }) : undefined)));
    expect(await runBrowserAction('click', { ref: 'e9' }, driver)).toEqual({ error: 'No element e9' });
    expect(of('Input.dispatchMouseEvent')).toEqual([]);
  });

  it('maps screenshot pixels back to page pixels', async () => {
    const { driver, of } = fakeDriver(
      scripted((expr) => (expr === VIEWPORT ? JSON.stringify({ width: 1000, height: 1200, dpr: 2, scrollX: 0, scrollY: 300 }) : undefined))
    );
    const shot = await runBrowserAction('screenshot', {}, driver);
    // 1200 CSS px × 2 เกิน 1568 → ย่อให้ด้านยาวเหลือ 1568
    const scale = 1568 / 1200;
    expect(of('Page.captureScreenshot')[0].clip).toEqual({ x: 0, y: 300, width: 1000, height: 1200, scale: scale / 2 });
    expect(shot[TOOL_IMAGES_KEY]).toEqual([{ mediaType: 'image/jpeg', data: 'SHOT' }]);
    expect(shot.note).toContain('1307x1568');

    await runBrowserAction('click', { x: 653, y: 1306 }, driver);
    const press = of('Input.dispatchMouseEvent')[1];
    expect(press.x).toBeCloseTo(653 / scale);
    expect(press.y).toBeCloseTo(1306 / scale);
  });

  it('needs a ref or coordinates', async () => {
    const { driver } = fakeDriver(scripted());
    expect((await runBrowserAction('click', {}, driver)).error).toMatch(/ref/);
  });
});

describe('screenshot', () => {
  it('captures at full resolution when the page is small', async () => {
    const { driver, of } = fakeDriver(
      scripted((expr) => (expr === VIEWPORT ? JSON.stringify({ width: 600, height: 700, dpr: 1.25, scrollX: 0, scrollY: 0 }) : undefined))
    );
    const res = await runBrowserAction('screenshot', {}, driver);
    expect(of('Page.captureScreenshot')[0]).toEqual({ format: 'jpeg', quality: 70 });
    expect(res.note).toContain('750x875');
  });
});

describe('type', () => {
  it('focuses, replaces the text and submits', async () => {
    const { driver, calls } = fakeDriver(scripted((expr) => (expr.startsWith(FOCUS_REF) ? JSON.stringify({ focused: true }) : undefined)));
    await runBrowserAction('type', { ref: 'e2', text: 'hello@example.com', submit: true }, driver);
    const focus = calls.find((c) => c.params.expression?.startsWith(FOCUS_REF))!;
    expect(focus.params.expression).toContain('["e2",true]');
    const input = calls.filter((c) => c.method.startsWith('Input.'));
    expect(input[0]).toEqual({ method: 'Input.insertText', params: { text: 'hello@example.com' } });
    expect(input[1].params).toMatchObject({ type: 'keyDown', key: 'Enter', text: '\r' });
  });

  it('picks <select> options by text', async () => {
    const { driver, calls } = fakeDriver(
      scripted((expr) =>
        expr.startsWith(FOCUS_REF)
          ? JSON.stringify({ select: true })
          : expr.startsWith(SELECT_OPTION)
            ? JSON.stringify({ selected: 'Thailand' })
            : undefined
      )
    );
    const res = await runBrowserAction('type', { ref: 'e4', text: 'thailand' }, driver);
    expect(res.note).toBe('Selected "Thailand".');
    expect(calls.some((c) => c.method === 'Input.insertText')).toBe(false);
  });

  it('refuses elements that cannot take input', async () => {
    const { driver } = fakeDriver(scripted((expr) => (expr.startsWith(FOCUS_REF) ? JSON.stringify({ focused: false }) : undefined)));
    expect((await runBrowserAction('type', { ref: 'e1', text: 'x' }, driver)).error).toMatch(/cannot take keyboard input/);
  });
});

describe('keyEvents', () => {
  it('builds key events for named keys, characters and shortcuts', () => {
    expect(keyEvents('Enter')[0]).toMatchObject({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    expect(keyEvents('esc')[0]).toMatchObject({ type: 'rawKeyDown', key: 'Escape' });
    expect(keyEvents('Control+a')[0]).toMatchObject({ type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 2 });
    expect(keyEvents('Control+a')[0]).not.toHaveProperty('text');
    expect(keyEvents('Shift+Tab')[0]).toMatchObject({ key: 'Tab', modifiers: 8 });
    expect(keyEvents('Space')[0]).toMatchObject({ key: ' ', text: ' ' });
    expect(keyEvents('Enter')[1]).toMatchObject({ type: 'keyUp' });
    expect(() => keyEvents('F13')).toThrow(/Unknown key/);
    expect(() => keyEvents('Hyper+a')).toThrow(/Unknown modifier/);
  });

  it('press reports bad keys instead of throwing', async () => {
    const { driver } = fakeDriver(scripted());
    expect((await runBrowserAction('press', { key: 'F13' }, driver)).error).toMatch(/Unknown key/);
  });
});

describe('wait', () => {
  it('polls until the text shows up', async () => {
    let polls = 0;
    const { driver } = fakeDriver(scripted((expr) => (expr.includes('innerText.includes') ? ++polls >= 3 : undefined)));
    const res = await runBrowserAction('wait', { text: 'Saved' }, driver);
    expect(res.note).toBe('"Saved" is on the page.');
  });

  it('gives up after the timeout', async () => {
    const { driver } = fakeDriver(scripted((expr) => (expr.includes('innerText.includes') ? false : undefined)));
    expect((await runBrowserAction('wait', { text: 'Never', ms: 2000 }, driver)).error).toMatch(/did not appear within 2s/);
  });
});

describe('console', () => {
  it('formats captured messages', async () => {
    const entries = [
      { level: 'error', text: 'TypeError: x is undefined' },
      { level: 'network', text: '404 GET /api/items' },
    ];
    const { driver } = fakeDriver((expr) => (expr === READ_CONSOLE ? JSON.stringify(entries) : undefined));
    expect((await runBrowserAction('console', {}, driver)).content).toBe('[error] TypeError: x is undefined\n[network] 404 GET /api/items');
  });

  it('starts capturing on pages loaded before the hook', async () => {
    const { driver, calls } = fakeDriver((expr) => (expr === READ_CONSOLE ? null : undefined));
    expect((await runBrowserAction('console', {}, driver)).content).toMatch(/capture started now/);
    expect(calls.some((c) => c.params.expression === PAGE_HOOK)).toBe(true);
  });
});

describe('evaluate', () => {
  it('returns values, errors and long results', async () => {
    const { driver } = fakeDriver((expr) =>
      expr === 'boom()' ? new Error('ReferenceError: boom is not defined') : expr === 'big' ? 'x'.repeat(12_000) : expr === 'n' ? 42 : undefined
    );
    expect(await runBrowserAction('evaluate', { expression: 'n' }, driver)).toEqual({ content: '42' });
    expect(await runBrowserAction('evaluate', { expression: 'void 0' }, driver)).toEqual({ content: 'undefined' });
    expect((await runBrowserAction('evaluate', { expression: 'boom()' }, driver)).error).toMatch(/boom is not defined/);
    expect((await runBrowserAction('evaluate', { expression: 'big' }, driver)).content).toMatch(/\[2000 more characters\]$/);
    expect((await runBrowserAction('evaluate', { expression: ' ' }, driver)).error).toMatch(/needs an expression/);
  });
});
