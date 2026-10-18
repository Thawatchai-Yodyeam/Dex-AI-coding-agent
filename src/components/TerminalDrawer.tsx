import React, { useEffect, useRef } from 'react';
import { TerminalSquare, Trash2, X, Square, Maximize2, Minimize2 } from 'lucide-react';
import type { ShellOutputEventPayload } from '../types/agent';
import type { Translation } from '../utils/i18n';

interface TerminalDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  logs: ShellOutputEventPayload[];
  onClearLogs: () => void;
  activeCommandId?: string | null;
  onKillCommand?: (id: string) => void;
  t: Translation;
  height: number;
  maximized: boolean;
  onToggleMaximize: () => void;
  onResizeStart: (e: React.MouseEvent) => void;
}

export const TerminalDrawer: React.FC<TerminalDrawerProps> = ({
  isOpen,
  onClose,
  logs,
  onClearLogs,
  activeCommandId,
  onKillCommand,
  t,
  height,
  maximized,
  onToggleMaximize,
  onResizeStart,
}) => {
  const consoleRef = useRef<HTMLDivElement>(null);

  // เลื่อนลงล่างสุดแบบทันที (smooth ทุก event ระหว่างสตรีมทำให้กระตุก) และเฉพาะเมื่ออยู่ใกล้ล่างอยู่แล้ว
  useEffect(() => {
    const el = consoleRef.current;
    if (!el || !isOpen) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [logs, isOpen]);

  if (!isOpen) return null;

  return (
    <section
      className={`terminal ${maximized ? 'is-maximized' : ''}`}
      style={maximized ? undefined : { height }}
      aria-label={t.liveTerminal}
    >
      {!maximized && (
        <div className="terminal-resize" onMouseDown={onResizeStart} title={t.dragToResize} aria-hidden="true" />
      )}
      <div className="terminal-header">
        <div className="terminal-title">
          <TerminalSquare size={15} aria-hidden="true" />
          {t.liveTerminal}
          {activeCommandId && (
            <span className="running-badge">
              <span className="pulse-dot" aria-hidden="true" />
              {t.running}
            </span>
          )}
        </div>
        <div className="terminal-actions">
          {activeCommandId && onKillCommand && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onKillCommand(activeCommandId)}>
              <Square size={12} fill="currentColor" aria-hidden="true" />
              {t.stopProcess}
            </button>
          )}
          <button type="button" className="icon-btn icon-btn-sm" onClick={onToggleMaximize} aria-label={maximized ? t.restoreTerminal : t.maximizeTerminal}>
            {maximized ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
          </button>
          <button type="button" className="icon-btn icon-btn-sm" onClick={onClearLogs} aria-label={t.clearTerminal}>
            <Trash2 size={14} aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn icon-btn-sm" onClick={onClose} aria-label={t.closeDrawer}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="terminal-console" ref={consoleRef} role="log" aria-live="polite">
        {logs.length === 0 ? (
          <div className="terminal-empty">{t.terminalEmpty}</div>
        ) : (
          logs.map((log) => (
            <div key={log.seq} className={`console-line line-${log.stream}`}>
              {log.stream === 'exit' ? <span className="exit-line">— {t.processExited(log.exit_code)} —</span> : log.text}
            </div>
          ))
        )}
      </div>
    </section>
  );
};
