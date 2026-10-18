import React, { useState, useEffect, useRef } from 'react';
import type { AppSettings, ChatMessage, ChatSession, TokenUsage } from '../types/agent';
import type { MultiProviderAgentService } from '../services/agent';

export const SESSIONS_STORAGE_KEY = 'dex_chat_sessions_v1';
export const ACTIVE_SESSION_STORAGE_KEY = 'dex_active_session_id';

const PERSIST_DEBOUNCE_MS = 500;
const DEFAULT_TITLES = ['การสนทนาใหม่', 'New Chat', 'Untitled Chat', 'แชทใหม่', ''];

export function createNewSession(lang: string = 'th'): ChatSession {
  const now = Date.now();
  return {
    id: `session-${now}-${Math.random().toString(36).slice(2, 7)}`,
    title: lang === 'en' ? 'New Chat' : 'การสนทนาใหม่',
    messages: [],
    createdAt: now,
    updatedAt: now,
    sessionTokens: 0,
  };
}

interface InitialState {
  sessions: ChatSession[];
  activeId: string;
}

/** อ่าน localStorage ครั้งเดียว (เดิม parse JSON ก้อนเดียวกัน 4 รอบ) */
function loadInitialState(lang: string): InitialState {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSIONS_STORAGE_KEY) || 'null');
    if (Array.isArray(parsed) && parsed.length > 0) {
      const sessions = parsed.filter((s) => s && typeof s.id === 'string' && Array.isArray(s.messages));
      if (sessions.length > 0) {
        const savedActive = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
        const activeId = sessions.some((s) => s.id === savedActive) ? savedActive! : sessions[0].id;
        return { sessions, activeId };
      }
    }
  } catch (e) {
    console.error('Failed to load chat sessions:', e);
  }
  const fresh = createNewSession(lang);
  return { sessions: [fresh], activeId: fresh.id };
}

/** รูป base64 ใหญ่เกิน localStorage (~5 MB) — บันทึกแค่ชื่อ/ชนิด */
export function stripImageData(sessions: ChatSession[]): ChatSession[] {
  return sessions.map((s) =>
    s.messages.some((m) => m.images?.some((i) => i.data))
      ? {
          ...s,
          messages: s.messages.map((m) =>
            m.images ? { ...m, images: m.images.map(({ data: _data, ...rest }) => rest) } : m
          ),
        }
      : s
  );
}

function toHistoryPayload(messages: ChatMessage[]) {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

export interface UseChatSessionsReturn {
  sessions: ChatSession[];
  currentSessionId: string;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  sessionTokens: number;
  setSessionTokens: React.Dispatch<React.SetStateAction<number>>;
  lastTokenUsage: TokenUsage | null;
  setLastTokenUsage: React.Dispatch<React.SetStateAction<TokenUsage | null>>;
  handleNewChat: () => void;
  handleSelectSession: (id: string) => void;
  handleDeleteSession: (id: string) => void;
  handleRenameSession: (id: string, newTitle: string) => void;
  handleClearChat: () => void;
}

export function useChatSessions(
  settings: AppSettings,
  agentServiceRef: React.RefObject<MultiProviderAgentService | null>,
  /** getter (ไม่ใช่ค่า) เพื่อให้ได้สถานะล่าสุดเสมอ ไม่ล้า 1 render */
  getIsRunning: () => boolean,
  onStopExecution: () => void,
  onClearTerminal?: () => void
): UseChatSessionsReturn {
  const [initial] = useState(() => loadInitialState(settings.language));
  const [sessions, setSessions] = useState<ChatSession[]>(initial.sessions);
  const [currentSessionId, setCurrentSessionId] = useState<string>(initial.activeId);
  const initialSession = initial.sessions.find((s) => s.id === initial.activeId);
  const [messages, setMessages] = useState<ChatMessage[]>(initialSession?.messages ?? []);
  const [sessionTokens, setSessionTokens] = useState<number>(initialSession?.sessionTokens ?? 0);
  const [lastTokenUsage, setLastTokenUsage] = useState<TokenUsage | null>(null);

  // ให้ agent รู้ประวัติของ session ที่เปิดค้างไว้ตอนเปิดแอป
  useEffect(() => {
    agentServiceRef.current?.setHistory(toHistoryPayload(initialSession?.messages ?? []));
  }, []);

  useEffect(() => {
    if (currentSessionId) localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, currentSessionId);
  }, [currentSessionId]);

  // บันทึกแบบ debounce: ระหว่างสตรีม messages เปลี่ยนทุก ~40ms — ไม่ควร stringify ทุกครั้ง
  const latestSessionsRef = useRef(sessions);
  latestSessionsRef.current = sessions;
  useEffect(() => {
    const persist = () => {
      try {
        localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(stripImageData(latestSessionsRef.current)));
      } catch (e) {
        console.error('Failed to save sessions (storage quota?):', e);
      }
    };
    const timer = setTimeout(persist, PERSIST_DEBOUNCE_MS);
    window.addEventListener('beforeunload', persist);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('beforeunload', persist);
    };
  }, [sessions]);

  // ซิงก์ข้อความ/โทเคนของ session ที่เปิดอยู่ และตั้งชื่อแชทอัตโนมัติจาก prompt แรก
  useEffect(() => {
    if (!currentSessionId) return;
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === currentSessionId);
      if (idx === -1) return prev;
      const current = prev[idx];
      if (current.messages === messages && current.sessionTokens === sessionTokens) return prev;

      let title = current.title;
      if (DEFAULT_TITLES.includes(title)) {
        const firstUser = messages.find((m) => m.role === 'user' && m.content.trim());
        if (firstUser) {
          const clean = firstUser.content.replace(/[\r\n]+/g, ' ').trim();
          title = clean.length > 40 ? `${clean.slice(0, 40)}…` : clean;
        }
      }

      const copy = [...prev];
      copy[idx] = {
        ...current,
        title,
        messages,
        sessionTokens,
        model: settings.model,
        provider: settings.provider,
        updatedAt: messages.length > 0 ? Date.now() : current.updatedAt,
      };
      return copy;
    });
  }, [messages, sessionTokens, currentSessionId, settings.model, settings.provider]);

  const activate = (session: ChatSession) => {
    setCurrentSessionId(session.id);
    setMessages(session.messages || []);
    setSessionTokens(session.sessionTokens || 0);
    setLastTokenUsage(null);
    onClearTerminal?.();
    agentServiceRef.current?.setHistory(toHistoryPayload(session.messages || []));
  };

  const handleNewChat = () => {
    if (getIsRunning()) onStopExecution();
    // ถ้า session ปัจจุบันยังว่างอยู่ ไม่ต้องสร้างใหม่ซ้อน
    const current = sessions.find((s) => s.id === currentSessionId);
    if (current && current.messages.length === 0 && messages.length === 0) return;
    const fresh = createNewSession(settings.language);
    setSessions((prev) => [fresh, ...prev]);
    activate(fresh);
  };

  const handleSelectSession = (targetId: string) => {
    if (targetId === currentSessionId) return;
    if (getIsRunning()) onStopExecution();
    const target = sessions.find((s) => s.id === targetId);
    if (target) activate(target);
  };

  const handleDeleteSession = (sessionId: string) => {
    const remaining = sessions.filter((s) => s.id !== sessionId);
    if (remaining.length === 0) {
      if (getIsRunning()) onStopExecution();
      const fresh = createNewSession(settings.language);
      setSessions([fresh]);
      activate(fresh);
      return;
    }
    setSessions(remaining);
    if (sessionId === currentSessionId) {
      if (getIsRunning()) onStopExecution();
      activate(remaining[0]);
    }
  };

  const handleRenameSession = (sessionId: string, newTitle: string) => {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, title: newTitle } : s)));
  };

  const handleClearChat = () => {
    if (getIsRunning()) onStopExecution();
    setMessages([]);
    setSessionTokens(0);
    setLastTokenUsage(null);
    onClearTerminal?.();
    agentServiceRef.current?.clearHistory();
  };

  return {
    sessions,
    currentSessionId,
    messages,
    setMessages,
    sessionTokens,
    setSessionTokens,
    lastTokenUsage,
    setLastTokenUsage,
    handleNewChat,
    handleSelectSession,
    handleDeleteSession,
    handleRenameSession,
    handleClearChat,
  };
}
