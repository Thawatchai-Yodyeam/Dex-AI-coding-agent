import React, { useState } from 'react';
import { Folder, TerminalSquare, Eraser, Zap, ShieldCheck, AppWindow, Palette } from 'lucide-react';
import type { Translation } from '../utils/i18n';

interface TopBarProps {
  title: string;
  cwd: string;
  autoPilot: boolean;
  terminalOpen: boolean;
  browserOpen: boolean;
  designOpen: boolean;
  hasMessages: boolean;
  t: Translation;
  onSelectWorkspace: () => void;
  onToggleAutoPilot: () => void;
  onToggleTerminal: () => void;
  onToggleBrowser: () => void;
  onToggleDesign: () => void;
  onClearChat: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  title,
  cwd,
  autoPilot,
  terminalOpen,
  browserOpen,
  designOpen,
  hasMessages,
  t,
  onSelectWorkspace,
  onToggleAutoPilot,
  onToggleTerminal,
  onToggleBrowser,
  onToggleDesign,
  onClearChat,
}) => {
  const [confirmClear, setConfirmClear] = useState(false);

  const handleClear = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    setConfirmClear(false);
    onClearChat();
  };

  return (
    <header className="topbar">
      <div className="topbar-title" title={title}>
        {hasMessages ? title : ''}
      </div>
      <div className="topbar-actions">
        <button type="button" className="chip-btn chip-outline workspace-chip" onClick={onSelectWorkspace} title={`${t.workspaceTitle}\n${cwd}`}>
          <Folder size={14} aria-hidden="true" />
          <span className="workspace-chip-text">{cwd || t.chooseWorkspace}</span>
        </button>
        <button
          type="button"
          className={`chip-btn chip-outline mode-chip ${autoPilot ? 'is-auto' : ''}`}
          onClick={onToggleAutoPilot}
          aria-pressed={autoPilot}
          title={autoPilot ? t.modeAutoPilotTooltip : t.modeSupervisedTooltip}
        >
          {autoPilot ? <Zap size={14} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
          <span className="mode-chip-text">{autoPilot ? t.modeAutoPilot : t.modeSupervised}</span>
        </button>
        {hasMessages && (
          <button
            type="button"
            className={`icon-btn ${confirmClear ? 'is-danger' : ''}`}
            onClick={handleClear}
            aria-label={confirmClear ? t.confirmClearChat : t.clearChat}
            title={confirmClear ? t.confirmClearChat : t.clearChat}
          >
            <Eraser size={18} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className={`icon-btn ${terminalOpen ? 'is-active' : ''}`}
          onClick={onToggleTerminal}
          aria-pressed={terminalOpen}
          aria-label={t.terminalToggle}
          title={t.terminalToggle}
        >
          <TerminalSquare size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`icon-btn ${browserOpen ? 'is-active' : ''}`}
          onClick={onToggleBrowser}
          aria-pressed={browserOpen}
          aria-label={t.browserToggle}
          title={t.browserToggle}
        >
          <AppWindow size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`icon-btn ${designOpen ? 'is-active' : ''}`}
          onClick={onToggleDesign}
          aria-pressed={designOpen}
          aria-label={t.designToggle}
          title={t.designToggle}
        >
          <Palette size={18} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
};
