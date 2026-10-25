import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { BrowserPane } from './components/BrowserPane';
import { ChatHistorySidebar } from './components/ChatHistorySidebar';
import { ChatMessageItem } from './components/ChatMessageItem';
import { Composer } from './components/Composer';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SettingsModal } from './components/SettingsModal';
import { TerminalDrawer } from './components/TerminalDrawer';
import { TopBar } from './components/TopBar';
import { Welcome } from './components/Welcome';
import { tauriBridge } from './services/tauriBridge';
import { loadStoredSessions, type StoredSessions } from './services/sessionStore';
import { browserPane } from './services/browser/pane';
import type { AppSettings, PokemonTheme, ShellOutputEventPayload } from './types/agent';
import { POKEMON_THEMES } from './types/agent';
import { translations } from './utils/i18n';
import { useAppSettings } from './hooks/useAppSettings';
import { useResizablePanel } from './hooks/useResizablePanel';
import { useChatSessions } from './hooks/useChatSessions';
import { useAgentChat, type UseAgentChatReturn } from './hooks/useAgentChat';
import './App.css';

const MAX_TERMINAL_LINES = 1000;

/** ใช้ธีมกับ <html data-theme> และติดตามธีมระบบเมื่อเลือก "ตามระบบ" */
function useThemePreference(theme: AppSettings['theme']) {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const fixed = theme === 'light' || theme === 'dark' || POKEMON_THEMES.includes(theme as PokemonTheme);
      const effective = fixed ? theme! : media.matches ? 'dark' : 'light';
      document.documentElement.dataset.theme = effective;
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}

function AppShell({ stored }: { stored: StoredSessions }) {
  const { settings, setSettings, agentServiceRef, handleSelectWorkspace } = useAppSettings();
  const t = translations[settings.language];
  useThemePreference(settings.theme);

  const layout = useResizablePanel();
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [terminalLogs, setTerminalLogs] = useState<ShellOutputEventPayload[]>([]);

  // useChatSessions ต้องใช้สถานะของ useAgentChat (ซึ่งต้องใช้ setter จาก useChatSessions)
  // จึงเชื่อมกันผ่าน ref ที่อ่านตอนถูกเรียก ไม่ใช่ตอน render
  const chatRef = useRef<UseAgentChatReturn | null>(null);
  const clearTerminal = useCallback(() => setTerminalLogs([]), []);
  // คงที่ — SettingsModal ใช้ใน effect (focus/Escape) ถ้าเปลี่ยนทุก render จะแย่ง focus จากช่องกรอก
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const sessions = useChatSessions(
    stored,
    settings,
    agentServiceRef,
    () => chatRef.current?.isRunningRef.current ?? false,
    () => chatRef.current?.handleStopExecution(),
    clearTerminal
  );

  const chat = useAgentChat({
    settings,
    sessionId: sessions.currentSessionId,
    messages: sessions.messages,
    agentServiceRef,
    setMessages: sessions.setMessages,
    setSessionTokens: sessions.setSessionTokens,
    setLastTokenUsage: sessions.setLastTokenUsage,
    onOpenSettings: () => setSettingsOpen(true),
    onClearChat: sessions.handleClearChat,
    onAddPermissionRule: (rule) =>
      setSettings((prev) => ({ ...prev, permissionRules: [...(prev.permissionRules ?? []), rule] })),
  });
  chatRef.current = chat;

  const { setActiveCommandId, removeBackgroundCommand } = chat;

  // สตรีม output ของ PowerShell (เก็บไม่เกิน MAX_TERMINAL_LINES บรรทัด)
  useEffect(() => {
    let seq = 0;
    const unlistenPromise = tauriBridge
      .onShellOutput((payload) => {
      const line = { ...payload, seq: seq++ };
      setTerminalLogs((prev) => {
        const next = prev.length >= MAX_TERMINAL_LINES ? prev.slice(-(MAX_TERMINAL_LINES - 1)) : prev.slice();
        next.push(line);
        return next;
      });
      if (payload.stream === 'exit') {
        // คำสั่งเบื้องหลังจบระหว่างที่คำสั่งอื่นรันอยู่ — อย่าล้างสถานะของคำสั่งนั้น
        setActiveCommandId((prev) => (prev === payload.id ? null : prev));
        removeBackgroundCommand(payload.id);
      }
      })
      .catch((err) => {
        console.warn('shell-output listener unavailable:', err);
        return null;
      });
    return () => {
      unlistenPromise.then((unlisten) => unlisten?.());
    };
  }, [setActiveCommandId, removeBackgroundCommand]);

  // browser pane: ตามสถานะจากฝั่ง Rust และซ่อน webview ตอนหน้าตั้งค่าเปิด (native webview จะบัง modal)
  const browser = useSyncExternalStore(browserPane.subscribe, browserPane.getState);
  useEffect(() => {
    const unlisten = tauriBridge.onBrowserState(browserPane.handleEvent).catch(() => null);
    return () => {
      unlisten.then((fn) => fn?.());
    };
  }, []);
  useEffect(() => browserPane.setObscured(settingsOpen), [settingsOpen]);

  // เลื่อนลงล่างอัตโนมัติ เฉพาะเมื่อผู้ใช้อยู่ใกล้ล่างอยู่แล้ว (ไม่แย่ง scroll ตอนกำลังอ่านข้อความเก่า)
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const { messages } = sessions;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const updateSettings = (patch: Partial<AppSettings>) => setSettings((prev) => ({ ...prev, ...patch }));
  const currentSession = sessions.sessions.find((s) => s.id === sessions.currentSessionId);
  const lastMessageId = messages[messages.length - 1]?.id;
  // regenerate ได้เฉพาะคำตอบล่าสุดที่ตามหลังข้อความผู้ใช้ตรง ๆ (ไม่ใช่โน้ตของแอป เช่น /help หรือผลการย้อนไฟล์)
  const regenerableId =
    !chat.isRunning &&
    messages[messages.length - 1]?.role === 'assistant' &&
    messages[messages.length - 2]?.role === 'user'
      ? lastMessageId
      : undefined;

  const composer = (empty: boolean) => (
    <Composer
      value={chat.inputPrompt}
      onChange={chat.setInputPrompt}
      onSend={() => chat.handleSendMessage()}
      onStop={chat.handleStopExecution}
      isRunning={chat.isRunning}
      settings={settings}
      onUpdateSettings={updateSettings}
      sessionTokens={sessions.sessionTokens}
      lastTokenUsage={sessions.lastTokenUsage}
      onResetTokens={() => {
        sessions.setSessionTokens(0);
        sessions.setLastTokenUsage(null);
      }}
      placeholder={empty ? t.welcomePlaceholder : t.inputPlaceholder}
      t={t}
      autoFocus
      showTokens={!empty}
      images={chat.attachedImages}
      onImagesChange={chat.setAttachedImages}
    />
  );

  return (
    <div
      className={`app ${layout.isDraggingSidebar ? 'is-resizing-x' : ''} ${layout.isDraggingTerminal ? 'is-resizing-y' : ''}`}
      lang={settings.language}
    >
      <ChatHistorySidebar
        sessions={sessions.sessions}
        currentSessionId={sessions.currentSessionId}
        onSelectSession={sessions.handleSelectSession}
        onNewChat={sessions.handleNewChat}
        onDeleteSession={sessions.handleDeleteSession}
        onRenameSession={sessions.handleRenameSession}
        onOpenSettings={() => setSettingsOpen(true)}
        t={t}
        width={layout.sidebarWidth}
        collapsed={layout.sidebarCollapsed}
        onToggleCollapse={layout.toggleSidebarCollapse}
        workspace={settings.cwd}
        autoPilot={settings.autoPilot}
        onInsertPrompt={chat.setInputPrompt}
      />

      {!layout.sidebarCollapsed && (
        <div
          className="resize-x"
          onMouseDown={layout.handleSidebarResizeStart}
          title={t.dragToResize}
          aria-hidden="true"
        />
      )}

      <main className="main">
        <TopBar
          title={currentSession?.title || t.untitledChat}
          cwd={settings.cwd}
          autoPilot={settings.autoPilot}
          terminalOpen={terminalOpen}
          browserOpen={browser.visible}
          hasMessages={messages.length > 0}
          t={t}
          onSelectWorkspace={handleSelectWorkspace}
          onToggleAutoPilot={() => updateSettings({ autoPilot: !settings.autoPilot })}
          onToggleTerminal={() => setTerminalOpen((v) => !v)}
          onToggleBrowser={() => browserPane.setVisible(!browser.visible)}
          onClearChat={sessions.handleClearChat}
        />

        {sessions.saveError && (
          <div className="save-error" role="alert">
            {t.chatSaveFailed(sessions.saveError)}
          </div>
        )}

        {messages.length === 0 ? (
          <div className="main-scroll is-centered">
            <Welcome t={t} composer={composer(true)} onQuickPrompt={(p) => chat.handleSendMessage(p)} />
          </div>
        ) : (
          <>
            <div
              className="main-scroll"
              ref={scrollRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
              }}
            >
              <div className="thread">
                {messages.map((message) => (
                  <ChatMessageItem
                    key={message.id}
                    message={message}
                    t={t}
                    isStreaming={chat.isRunning && message.id === lastMessageId}
                    onApproveTool={chat.handleApproveTool}
                    onRejectTool={chat.handleRejectTool}
                    canUndo={!chat.isRunning && chat.canUndoTurn(message.id)}
                    onUndo={chat.handleUndoTurn}
                    onRegenerate={message.id === regenerableId ? chat.handleRegenerate : undefined}
                    onEditUser={chat.isRunning ? undefined : chat.handleEditUser}
                  />
                ))}
              </div>
            </div>
            <div className="composer-dock">
              {composer(false)}
              <p className="composer-disclaimer">{t.disclaimer}</p>
            </div>
          </>
        )}

        <TerminalDrawer
          isOpen={terminalOpen}
          onClose={() => setTerminalOpen(false)}
          logs={terminalLogs}
          onClearLogs={clearTerminal}
          activeCommandId={chat.activeCommandId}
          backgroundCommands={chat.backgroundCommands}
          onKillCommand={(id) => tauriBridge.killCommand(id)}
          t={t}
          height={layout.terminalHeight}
          maximized={layout.terminalMaximized}
          onToggleMaximize={layout.toggleTerminalMaximize}
          onResizeStart={layout.handleTerminalResizeStart}
        />
      </main>

      {browser.visible && <BrowserPane t={t} />}

      <SettingsModal
        isOpen={settingsOpen}
        onClose={closeSettings}
        settings={settings}
        onSave={setSettings}
      />
    </div>
  );
}

export function App() {
  // ภาษาของหน้าจอ error อ่านจาก localStorage ตรงๆ เพราะ boundary อยู่นอก state ของแอป
  let language: 'th' | 'en' = 'th';
  try {
    language = JSON.parse(localStorage.getItem('dex_agent_settings_v2') || '{}').language === 'en' ? 'en' : 'th';
  } catch {
    // ใช้ค่า default
  }
  // แชทเก็บเป็นไฟล์ (อ่านแบบ async) — รอให้โหลดเสร็จก่อนค่อยวาด ไม่งั้นแชทใหม่ที่ว่างเปล่าจะโผล่มาแวบหนึ่ง
  const [stored, setStored] = useState<StoredSessions | null>(null);
  useEffect(() => {
    loadStoredSessions()
      .catch((e) => {
        console.error('Failed to load chat sessions:', e);
        return { sessions: [], activeId: null };
      })
      .then(setStored);
  }, []);
  return <ErrorBoundary language={language}>{stored && <AppShell stored={stored} />}</ErrorBoundary>;
}

export default App;
