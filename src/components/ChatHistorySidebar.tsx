import React, { useState } from 'react';
import {
  MessageSquare,
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  PanelLeft,
  Folder,
  Settings,
  Blocks,
} from 'lucide-react';
import type { ChatSession } from '../types/agent';
import type { Translation } from '../utils/i18n';
import { FileExplorer } from './FileExplorer';
import { DexMark } from './DexMark';

interface ChatHistorySidebarProps {
  sessions: ChatSession[];
  currentSessionId: string;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, newTitle: string) => void;
  onOpenSettings: () => void;
  t: Translation;
  width: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  workspace: string;
  autoPilot: boolean;
  onInsertPrompt: (text: string) => void;
  /** คอลัมน์หลักกำลังแสดงหน้า Customizations */
  customizationsOpen: boolean;
  onOpenCustomizations: () => void;
  /** กลับมาแสดงแชทในคอลัมน์หลัก */
  onShowChat: () => void;
}

export const ChatHistorySidebar: React.FC<ChatHistorySidebarProps> = ({
  sessions,
  currentSessionId,
  onSelectSession,
  onNewChat,
  onDeleteSession,
  onRenameSession,
  onOpenSettings,
  t,
  width,
  collapsed,
  onToggleCollapse,
  workspace,
  autoPilot,
  onInsertPrompt,
  customizationsOpen,
  onOpenCustomizations,
  onShowChat,
}) => {
  const [view, setView] = useState<'chats' | 'files'>('chats');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const saveRename = (id: string) => {
    const trimmed = editTitle.trim();
    if (trimmed) onRenameSession(id, trimmed);
    setEditingId(null);
  };

  const handleDelete = (id: string) => {
    if (confirmDeleteId === id) {
      onDeleteSession(id);
      setConfirmDeleteId(null);
      return;
    }
    setConfirmDeleteId(id);
    setTimeout(() => setConfirmDeleteId((prev) => (prev === id ? null : prev)), 3500);
  };

  if (collapsed) {
    return (
      <aside className="sidebar sidebar-rail">
        <button type="button" className="icon-btn" onClick={onToggleCollapse} aria-label={t.expandSidebar} title={t.expandSidebar}>
          <PanelLeft size={18} aria-hidden="true" />
        </button>
        <button type="button" className="icon-btn" onClick={onNewChat} aria-label={t.newChat} title={t.newChat}>
          <span className="new-chat-dot">
            <Plus size={14} strokeWidth={2.6} aria-hidden="true" />
          </span>
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => {
            setView('chats');
            onShowChat();
            onToggleCollapse();
          }}
          aria-label={t.chats}
          title={t.chats}
        >
          <MessageSquare size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => {
            setView('files');
            onShowChat();
            onToggleCollapse();
          }}
          aria-label={t.files}
          title={t.files}
        >
          <Folder size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`icon-btn ${customizationsOpen ? 'is-active' : ''}`}
          onClick={onOpenCustomizations}
          aria-pressed={customizationsOpen}
          aria-label={t.customizations}
          title={t.customizations}
        >
          <Blocks size={18} aria-hidden="true" />
        </button>
        <button type="button" className="icon-btn rail-bottom" onClick={onOpenSettings} aria-label={t.settings} title={t.settings}>
          <Settings size={18} aria-hidden="true" />
        </button>
      </aside>
    );
  }

  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-brand">
        <span className="brand">
          <DexMark size={20} />
          Dex
        </span>
        <button type="button" className="icon-btn" onClick={onToggleCollapse} aria-label={t.collapseSidebar} title={t.collapseSidebar}>
          <PanelLeft size={18} aria-hidden="true" />
        </button>
      </div>

      <nav className="sidebar-nav" aria-label="Dex">
        <button type="button" className="nav-item nav-new" onClick={onNewChat}>
          <span className="new-chat-dot">
            <Plus size={14} strokeWidth={2.6} aria-hidden="true" />
          </span>
          {t.newChat}
        </button>
        <button
          type="button"
          className={`nav-item ${view === 'chats' && !customizationsOpen ? 'is-active' : ''}`}
          aria-pressed={view === 'chats' && !customizationsOpen}
          onClick={() => {
            setView('chats');
            onShowChat();
          }}
        >
          <MessageSquare size={18} aria-hidden="true" />
          {t.chats}
        </button>
        <button
          type="button"
          className={`nav-item ${view === 'files' && !customizationsOpen ? 'is-active' : ''}`}
          aria-pressed={view === 'files' && !customizationsOpen}
          onClick={() => {
            setView('files');
            onShowChat();
          }}
        >
          <Folder size={18} aria-hidden="true" />
          {t.files}
        </button>
        <button
          type="button"
          className={`nav-item ${customizationsOpen ? 'is-active' : ''}`}
          aria-pressed={customizationsOpen}
          onClick={onOpenCustomizations}
        >
          <Blocks size={18} aria-hidden="true" />
          {t.customizations}
        </button>
      </nav>

      {view === 'files' ? (
        <FileExplorer workspace={workspace} t={t} onInsertPrompt={onInsertPrompt} />
      ) : (
        <div className="sidebar-scroll">
          <div className="sidebar-section-title">{t.recents}</div>
          {sorted.length === 0 && <p className="sidebar-empty">{t.noHistory}</p>}
          <ul className="session-list">
            {sorted.map((session) => {
              const active = session.id === currentSessionId;
              const confirming = session.id === confirmDeleteId;

              if (session.id === editingId) {
                return (
                  <li key={session.id} className="session-item is-editing">
                    <label htmlFor={`rename-${session.id}`} className="sr-only">
                      {t.renameChat}
                    </label>
                    <input
                      id={`rename-${session.id}`}
                      className="session-rename"
                      value={editTitle}
                      autoFocus
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveRename(session.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                    />
                    <button type="button" className="icon-btn icon-btn-sm" onClick={() => saveRename(session.id)} aria-label={t.saveTitle}>
                      <Check size={14} aria-hidden="true" />
                    </button>
                    <button type="button" className="icon-btn icon-btn-sm" onClick={() => setEditingId(null)} aria-label={t.cancelEdit}>
                      <X size={14} aria-hidden="true" />
                    </button>
                  </li>
                );
              }

              return (
                <li key={session.id} className={`session-item ${active ? 'is-active' : ''}`}>
                  <button
                    type="button"
                    className="session-link"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onSelectSession(session.id)}
                    title={session.title}
                  >
                    {session.title || t.untitledChat}
                  </button>
                  <div className="session-actions">
                    <button
                      type="button"
                      className="icon-btn icon-btn-sm"
                      onClick={() => {
                        setEditingId(session.id);
                        setEditTitle(session.title);
                      }}
                      aria-label={t.renameChat}
                      title={t.renameChat}
                    >
                      <Pencil size={13} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={`icon-btn icon-btn-sm ${confirming ? 'is-danger' : ''}`}
                      onClick={() => handleDelete(session.id)}
                      aria-label={confirming ? t.confirmDeleteChat : t.deleteChat}
                      title={confirming ? t.confirmDeleteChat : t.deleteChat}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="sidebar-footer">
        <span className="avatar" aria-hidden="true">
          <DexMark size={16} />
        </span>
        <div className="sidebar-footer-text">
          <div className="sidebar-footer-title">Dex Agent</div>
          <div className="sidebar-footer-sub">{autoPilot ? t.modeAutoPilot : t.modeSupervised}</div>
        </div>
        <button type="button" className="icon-btn" onClick={onOpenSettings} aria-label={t.settings} title={t.settings}>
          <Settings size={18} aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
};
