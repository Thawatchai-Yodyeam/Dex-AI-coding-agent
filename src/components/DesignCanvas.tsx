import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Download,
  ExternalLink,
  History,
  Monitor,
  PanelRightClose,
  Palette,
  Plus,
  RotateCw,
  Smartphone,
  Tablet,
  AppWindow,
} from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { browserPane } from '../services/browser/pane';
import { designCanvas, deviceFrame, type DesignCanvasState, type DesignDevice } from '../services/design/canvas';
import type { Translation } from '../utils/i18n';

const DEVICE_ICONS: Record<DesignDevice, typeof Monitor> = { desktop: Monitor, tablet: Tablet, mobile: Smartphone };
const DEVICES: DesignDevice[] = ['desktop', 'tablet', 'mobile'];

export const DesignToolbar: React.FC<{ state: DesignCanvasState; t: Translation; onStartDesign: () => void }> = ({ state, t, onStartDesign }) => {
  const { project, versions, viewing, device, url } = state;
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

  const frame = deviceFrame(state.device, available);
  useEffect(() => {
    if (showFrame && frame.width > 0 && frame.height > 0) designCanvas.reportFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- frame เป็น object ใหม่ทุก render
  }, [showFrame, frame.width, frame.height]);

  return (
    <div className={`design-stage is-${state.device}`} ref={stageRef}>
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
