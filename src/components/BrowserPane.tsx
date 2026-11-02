import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, PanelRightClose, AppWindow } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { browserPane } from '../services/browser/pane';
import { designCanvas } from '../services/design/canvas';
import { DesignComments, DesignNotices, DesignPages, DesignStage, DesignToolbar } from './DesignCanvas';
import type { Translation } from '../utils/i18n';

const WIDTH_KEY = 'dex_browser_width';
const DEFAULT_WIDTH = 560;
const MIN_WIDTH = 320;
/** canvas ของดีไซน์ต้องการที่มากกว่าเบราว์เซอร์ */
const DESIGN_MIN_OPEN_WIDTH = 720;
/** ให้แชทเหลือที่อย่างน้อยเท่านี้ (ต้องตรงกับ min-width ของ .main) — ที่ไม่พอ pane จะหดเอง */
const MIN_CHAT_WIDTH = 380;

/** `localhost:5173` → http://, `example.com` → https:// */
export function normalizeUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i.test(value);
  return `${local ? 'http' : 'https'}://${value}`;
}

function loadWidth(): number {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(saved) && saved >= MIN_WIDTH ? saved : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

/**
 * pane เบราว์เซอร์ทางขวา — ตัวหน้าเว็บเป็น native webview ที่ลอยทับกรอบ `.browser-viewport`
 * component นี้จึงคอยรายงานตำแหน่งของกรอบให้ webview ตามทุกครั้งที่ layout ขยับ
 */
export const BrowserPane: React.FC<{
  t: Translation;
  onStartDesign: () => void;
  agentRunning: boolean;
  onSendDesignComments: (prompt: string) => boolean;
}> = ({ t, onStartDesign, agentRunning, onSendDesignComments }) => {
  const state = useSyncExternalStore(browserPane.subscribe, browserPane.getState);
  const design = useSyncExternalStore(designCanvas.subscribe, designCanvas.getState);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(loadWidth);
  const [draft, setDraft] = useState('');
  // กำลังพิมพ์อยู่ = อย่าเอา URL ที่หน้าเว็บเปลี่ยนไปทับ
  const editingRef = useRef(false);

  // ขยายให้เมื่อเข้าโหมดดีไซน์ แต่ไม่จำลง localStorage (ความกว้างที่ผู้ใช้ลากเองเท่านั้นที่จำ)
  useEffect(() => {
    if (design.active) {
      setWidth((w) => Math.max(w, Math.min(DESIGN_MIN_OPEN_WIDTH, window.innerWidth - MIN_CHAT_WIDTH)));
    }
  }, [design.active]);

  useEffect(() => {
    if (!editingRef.current) setDraft(state.url === 'about:blank' ? '' : state.url);
  }, [state.url]);

  // ตามตำแหน่งทุกเฟรม: กรอบย้ายได้โดยขนาดไม่เปลี่ยน (เช่น ย่อแถบข้าง) ซึ่ง ResizeObserver ไม่แจ้ง
  useEffect(() => {
    let frame = 0;
    let last = '';
    const tick = () => {
      const el = viewportRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        const bounds = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
        const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
        if (key !== last && bounds.width > 0 && bounds.height > 0) {
          last = key;
          browserPane.reportViewport(bounds);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      browserPane.reportViewport(null);
    };
  }, []);

  // ลากขอบซ้ายเพื่อปรับความกว้าง — ซ่อน webview ระหว่างลาก ไม่งั้นมันกิน mouse event ตอนเมาส์ผ่าน
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    browserPane.setObscured(true, 'resize');
    let latest = width;
    const onMove = (ev: MouseEvent) => {
      latest = Math.min(Math.max(window.innerWidth - ev.clientX, MIN_WIDTH), window.innerWidth - MIN_CHAT_WIDTH);
      setWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      browserPane.setObscured(false, 'resize');
      try {
        localStorage.setItem(WIDTH_KEY, String(Math.round(latest)));
      } catch {
        // ไม่จำความกว้างก็ใช้ได้
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const go = (raw: string) => {
    const url = normalizeUrl(raw);
    if (!url) return;
    // คง URL ที่พิมพ์ไว้จนกว่าหน้าใหม่จะรายงาน URL จริงกลับมา — error แสดงผ่าน state.error
    setDraft(url);
    browserPane.navigate(url).catch(() => {});
  };

  const hasPage = state.created && !!state.url && state.url !== 'about:blank';

  if (design.active) {
    return (
      <>
        <div className="resize-x" onMouseDown={startResize} title={t.dragToResize} aria-hidden="true" />
        <aside className="browser-pane" style={{ width }} aria-label={t.designTitle}>
          <DesignToolbar state={design} t={t} onStartDesign={onStartDesign} />
          <DesignPages state={design} t={t} />
          <DesignNotices state={design} t={t} />
          <DesignComments state={design} t={t} agentRunning={agentRunning} onSend={onSendDesignComments} />
          <DesignStage state={design} t={t} frameRef={viewportRef} onStartDesign={onStartDesign} />
        </aside>
      </>
    );
  }

  return (
    <>
      <div className="resize-x" onMouseDown={startResize} title={t.dragToResize} aria-hidden="true" />
      <aside className="browser-pane" style={{ width }} aria-label={t.browserTitle}>
        <div className="browser-toolbar">
          <button type="button" className="icon-btn icon-btn-sm" onClick={() => void browserPane.goBack()} disabled={!hasPage} aria-label={t.browserBack} title={t.browserBack}>
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn icon-btn-sm" onClick={() => void browserPane.goForward()} disabled={!hasPage} aria-label={t.browserForward} title={t.browserForward}>
            <ArrowRight size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`icon-btn icon-btn-sm ${state.loading ? 'is-spinning' : ''}`}
            onClick={() => void browserPane.reload()}
            disabled={!hasPage}
            aria-label={t.browserReload}
            title={t.browserReload}
          >
            <RotateCw size={15} aria-hidden="true" />
          </button>
          <form
            className="browser-url-form"
            onSubmit={(e) => {
              e.preventDefault();
              go(draft);
              (e.currentTarget.elements.namedItem('browser-url') as HTMLInputElement | null)?.blur();
            }}
          >
            <label htmlFor="browser-url" className="sr-only">
              {t.browserUrlLabel}
            </label>
            <input
              id="browser-url"
              className="browser-url"
              value={draft}
              placeholder={t.browserUrlPlaceholder}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => {
                editingRef.current = true;
                e.currentTarget.select();
              }}
              onBlur={() => {
                editingRef.current = false;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setDraft(state.url);
                  e.currentTarget.blur();
                }
              }}
            />
          </form>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            onClick={() => openUrl(state.url).catch((err) => console.warn('openUrl failed:', err))}
            disabled={!hasPage}
            aria-label={t.browserOpenExternal}
            title={t.browserOpenExternal}
          >
            <ExternalLink size={15} aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn icon-btn-sm" onClick={() => browserPane.setVisible(false)} aria-label={t.browserHide} title={t.browserHide}>
            <PanelRightClose size={16} aria-hidden="true" />
          </button>
        </div>
        {state.error && (
          <p className="browser-error" role="alert">
            {t.browserLoadFailed(state.error)}
          </p>
        )}
        <div className="browser-viewport" ref={viewportRef}>
          {!state.created && (
            <div className="browser-empty">
              <AppWindow size={28} aria-hidden="true" />
              <p>{t.browserEmpty}</p>
            </div>
          )}
        </div>
      </aside>
    </>
  );
};
