import { useState, useEffect, useRef, useCallback } from 'react';
import { ChatHistorySidebar } from './components/ChatHistorySidebar';
import { ChatMessageItem } from './components/ChatMessageItem';
import { Composer } from './components/Composer';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SettingsModal } from './components/SettingsModal';
import { TerminalDrawer } from './components/TerminalDrawer';
import { TopBar } from './components/TopBar';
import { Welcome } from './components/Welcome';
import { tauriBridge } from './services/tauriBridge';
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

function AppShell() {
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
    settings,
    agentServiceRef,
    () => chatRef.current?.isRunningRef.current ?? false,
    () => chatRef.current?.handleStopExecution(),
    clearTerminal
  );

  const chat = useAgentChat({
    settings,
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

  const { setActiveCommandId } = chat;

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
      if (payload.stream === 'exit') setActiveCommandId(null);
      })
      .catch((err) => {
        console.warn('shell-output listener unavailable:', err);
        return null;
      });
    return () => {
      unlistenPromise.then((unlisten) => unlisten?.());
    };
  }, [setActiveCommandId]);

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
          hasMessages={messages.length > 0}
          t={t}
          onSelectWorkspace={handleSelectWorkspace}
          onToggleAutoPilot={() => updateSettings({ autoPilot: !settings.autoPilot })}
          onToggleTerminal={() => setTerminalOpen((v) => !v)}
          onClearChat={sessions.handleClearChat}
        />

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
          onKillCommand={(id) => tauriBridge.killCommand(id)}
          t={t}
          height={layout.terminalHeight}
          maximized={layout.terminalMaximized}
          onToggleMaximize={layout.toggleTerminalMaximize}
          onResizeStart={layout.handleTerminalResizeStart}
        />
      </main>

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
  return (
    <ErrorBoundary language={language}>
      <AppShell />
    </ErrorBoundary>
  );
}

export default App;
