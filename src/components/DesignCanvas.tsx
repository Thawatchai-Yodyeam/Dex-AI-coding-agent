import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Columns3,
  Download,
  ExternalLink,
  History,
  MessageSquarePlus,
  Monitor,
  PanelRightClose,
  Palette,
  Plus,
  RotateCw,
  Send,
  Smartphone,
  Tablet,
  AppWindow,
  X,
} from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { browserPane } from '../services/browser/pane';
import { designCanvas, deviceFrame, stageDevice, type DesignCanvasState, type DesignDevice } from '../services/design/canvas';
import type { Translation } from '../utils/i18n';

const DEVICE_ICONS: Record<DesignDevice, typeof Monitor> = { desktop: Monitor, tablet: Tablet, mobile: Smartphone };
const DEVICES: DesignDevice[] = ['desktop', 'tablet', 'mobile'];

export const DesignToolbar: React.FC<{ state: DesignCanvasState; t: Translation; onStartDesign: () => void }> = ({ state, t, onStartDesign }) => {
  const { project, versions, viewing, device, url, commenting, compare } = state;
  if (!project) {
    return (
      <div className="browser-toolbar design-toolbar">
        <span className="design-toolbar-title">
          <Palette size={16} aria-hidden="true" />
          {t.designTitle}
        </span>
        <button type="button" className="chip-btn chip-outline" onClick={onStartDesign}>
          <Plus size={14} aria-hidden="true" />
          {t.designNew}
        </button>
        <button type="button" className="icon-btn icon-btn-sm" onClick={() => designCanvas.exit()} aria-label={t.designToBrowser} title={t.designToBrowser}>
          <AppWindow size={16} aria-hidden="true" />
        </button>
        <button type="button" className="icon-btn icon-btn-sm" onClick={() => browserPane.setVisible(false)} aria-label={t.browserHide} title={t.browserHide}>
          <PanelRightClose size={16} aria-hidden="true" />
        </button>
      </div>
    );
  }
  return (
    <div className="browser-toolbar design-toolbar">
      <button type="button" className="icon-btn icon-btn-sm" onClick={() => void designCanvas.showGallery()} aria-label={t.designGallery} title={t.designGallery}>
        <ArrowLeft size={16} aria-hidden="true" />
      </button>
      <span className="design-toolbar-title" title={project.title}>
        <span className="design-toolbar-name">{project.title}</span>
      </span>
      <div className="design-devices" role="group" aria-label={t.designDevice}>
        {DEVICES.map((name) => {
          const Icon = DEVICE_ICONS[name];
          return (
            <button
              key={name}
              type="button"
              className={`icon-btn icon-btn-sm ${device === name ? 'is-active' : ''}`}
              onClick={() => designCanvas.setDevice(name)}
              aria-pressed={device === name}
              aria-label={t.designDevices[name]}
              title={t.designDevices[name]}
            >
              <Icon size={15} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className={`icon-btn icon-btn-sm ${commenting ? 'is-active' : ''}`}
        onClick={() => designCanvas.setCommenting(!commenting)}
        disabled={!url || viewing !== null || compare}
        aria-pressed={commenting}
        aria-label={t.designCommentMode}
        title={t.designCommentMode}
      >
        <MessageSquarePlus size={15} aria-hidden="true" />
      </button>
      {versions.length > 0 && (
        <label className="design-version" title={t.designVersions}>
          <History size={14} aria-hidden="true" />
          <span className="sr-only">{t.designVersions}</span>
          <select
            value={viewing ?? ''}
            onChange={(e) => void designCanvas.viewVersion(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">{t.designLatest(versions[versions.length - 1].version)}</option>
            {[...versions].reverse().map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version} · {v.summary}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="button" className="icon-btn icon-btn-sm" onClick={() => void designCanvas.show()} aria-label={t.browserReload} title={t.browserReload}>
        <RotateCw size={15} aria-hidden="true" />
      </button>
      <button type="button" className="icon-btn icon-btn-sm" onClick={() => void designCanvas.exportProject()} aria-label={t.designExport} title={t.designExport}>
        <Download size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn-sm"
        onClick={() => url && openUrl(url).catch((err) => console.warn('openUrl failed:', err))}
        disabled={!url}
        aria-label={t.browserOpenExternal}
        title={t.browserOpenExternal}
      >
        <ExternalLink size={15} aria-hidden="true" />
      </button>
      <button type="button" className="icon-btn icon-btn-sm" onClick={() => browserPane.setVisible(false)} aria-label={t.browserHide} title={t.browserHide}>
        <PanelRightClose size={16} aria-hidden="true" />
      </button>
    </div>
  );
};

/** แท็บของแต่ละหน้า (หลายหน้าเว็บ หรือหลายแบบให้เลือก) และปุ่มเทียบเคียงกัน — แสดงเมื่อมีตั้งแต่ 2 หน้า */
export const DesignPages: React.FC<{ state: DesignCanvasState; t: Translation }> = ({ state, t }) => {
  if (state.pages.length < 2 || !state.url) return null;
  return (
    <div className="design-pages" role="group" aria-label={t.designPages}>
      <div className="design-page-tabs">
        {state.pages.map((page) => {
          const current = !state.compare && page === state.page;
          return (
            <button
              key={page}
              type="button"
              className={`design-page-tab ${current ? 'is-active' : ''}`}
              aria-pressed={current}
              onClick={() => void designCanvas.viewPage(page)}
            >
              {page.replace(/\.html?$/i, '')}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className={`chip-btn chip-outline ${state.compare ? 'is-active' : ''}`}
        aria-pressed={state.compare}
        disabled={state.viewing !== null}
        onClick={() => void designCanvas.setCompare(!state.compare)}
      >
        <Columns3 size={14} aria-hidden="true" />
        {t.designCompare}
      </button>
    </div>
  );
};

/** แถบคอมเมนต์: พิมพ์ที่นี่ในหน้าแอป ไม่ใช่ในหน้าเว็บ หน้าเว็บจึงแต่งคำขอแทนผู้ใช้ไม่ได้ */
export const DesignComments: React.FC<{
  state: DesignCanvasState;
  t: Translation;
  agentRunning: boolean;
  /** คืน false ถ้าแชทยังรับข้อความไม่ได้ */
  onSend: (prompt: string) => boolean;
}> = ({ state, t, agentRunning, onSend }) => {
  const { commenting, draft, comments } = state;
  const [note, setNote] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setNote('');
    if (draft) inputRef.current?.focus();
  }, [draft]);
  if (!commenting) return null;
  const pending = comments.filter((c) => !c.sent).length;
  const send = () => {
    const prompt = designCanvas.pendingPrompt(t.designCommentsIntro);
    if (prompt && onSend(prompt)) void designCanvas.markCommentsSent();
  };
  return (
    <section className="design-comments" aria-label={t.designCommentMode}>
      {draft ? (
        <form
          className="design-comment-form"
          onSubmit={(e) => {
            e.preventDefault();
            void designCanvas.addComment(note);
          }}
        >
          <div className="design-comment-target">
            <code>{draft.tag}</code>
            <span>{draft.text}</span>
          </div>
          <div className="design-comment-input">
            <label htmlFor="design-comment-note" className="sr-only">
              {t.designCommentPlaceholder}
            </label>
            <input
              id="design-comment-note"
              ref={inputRef}
              value={note}
              placeholder={t.designCommentPlaceholder}
              autoComplete="off"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') designCanvas.cancelDraft();
              }}
            />
            <button type="submit" className="chip-btn chip-outline" disabled={!note.trim()}>
              {t.designCommentAdd}
            </button>
            <button type="button" className="icon-btn icon-btn-sm" onClick={() => designCanvas.cancelDraft()} aria-label={t.designCommentCancel} title={t.designCommentCancel}>
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        </form>
      ) : (
        <p className="design-comment-hint">{t.designCommentHint}</p>
      )}
      {comments.length > 0 && (
        <>
          <ol className="design-comment-list">
            {comments.map((comment) => (
              <li key={comment.id} className={comment.sent ? 'is-sent' : undefined}>
                <span className="design-comment-text" title={comment.text}>
                  {comment.note}
                </span>
                {comment.page !== state.page && <span className="design-comment-tag">{comment.page}</span>}
                {comment.sent && <span className="design-comment-tag">{t.designCommentSent}</span>}
                <button type="button" className="icon-btn icon-btn-sm" onClick={() => void designCanvas.removeComment(comment.id)} aria-label={t.designCommentRemove} title={t.designCommentRemove}>
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ol>
          <button type="button" className="chip-btn chip-outline design-comment-send" disabled={pending === 0 || agentRunning} onClick={send}>
            <Send size={14} aria-hidden="true" />
            {t.designCommentSend(pending)}
          </button>
        </>
      )}
    </section>
  );
};

/** แถบแจ้งผลใต้ toolbar: กำลังดูเวอร์ชันเก่า, error และ export สำเร็จ */
export const DesignNotices: React.FC<{ state: DesignCanvasState; t: Translation }> = ({ state, t }) => (
  <>
    {state.viewing !== null && (
      <div className="design-notice">
        <span>{t.designViewingOld(state.viewing)}</span>
        <button type="button" className="chip-btn chip-outline" onClick={() => void designCanvas.restoreViewing()}>
          {t.designRestore}
        </button>
      </div>
    )}
    {state.notice && (
      <p className="design-notice" role="status">
        {t.designExported(state.notice)}
      </p>
    )}
    {state.error && (
      <p className="browser-error" role="alert">
        {state.error}
      </p>
    )}
  </>
);

/**
 * พื้นที่แสดงดีไซน์: แกลเลอรี หรือกรอบของจอจำลองที่ native webview จะลอยทับ
 * `frameRef` คือกรอบที่ BrowserPane รายงานตำแหน่งให้ webview ตาม
 */
export const DesignStage: React.FC<{
  state: DesignCanvasState;
  t: Translation;
  frameRef: React.RefObject<HTMLDivElement | null>;
  onStartDesign: () => void;
}> = ({ state, t, frameRef, onStartDesign }) => {
  const stageRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  const showFrame = !!state.project && !!state.url;

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setAvailable({ width: Math.floor(width), height: Math.floor(height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const device = stageDevice(state);
  const frame = deviceFrame(device, available);
  useEffect(() => {
    if (showFrame && frame.width > 0 && frame.height > 0) designCanvas.reportFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- frame เป็น object ใหม่ทุก render
  }, [showFrame, frame.width, frame.height]);

  return (
    <div className={`design-stage is-${device}`} ref={stageRef}>
      {showFrame ? (
        <div className="design-frame" ref={frameRef} style={{ width: frame.width, height: frame.height }} />
      ) : state.project ? (
        <div className="browser-empty">
          <Palette size={28} aria-hidden="true" />
          <p>{t.designNoPage}</p>
        </div>
      ) : state.projects.length === 0 ? (
        <div className="browser-empty">
          <Palette size={28} aria-hidden="true" />
          <p>{t.designEmpty}</p>
          <button type="button" className="chip-btn chip-outline" onClick={onStartDesign}>
            <Plus size={14} aria-hidden="true" />
            {t.designNew}
          </button>
        </div>
      ) : (
        <ul className="design-gallery">
          {state.projects.map((project) => (
            <li key={project.id}>
              <button type="button" className="design-card" onClick={() => void designCanvas.open(project.id)}>
                <span className="design-card-title">{project.title}</span>
                <span className="design-card-meta">
                  {t.designCardMeta(project.version, new Date(project.updated_at).toLocaleDateString(t.dateLocale))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
