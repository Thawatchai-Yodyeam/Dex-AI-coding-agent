import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { AppSettings, ChatMessage, ChatSession, TokenUsage } from '../types/agent';
import type { MultiProviderAgentService } from '../services/agent';
import { tauriBridge } from '../services/tauriBridge';
import { ACTIVE_SESSION_STORAGE_KEY, sessionStore, type StoredSessions } from '../services/sessionStore';

const PERSIST_DEBOUNCE_MS = 500;
/** ระหว่างสตรีม messages เปลี่ยนตลอด debounce จะเลื่อนไปเรื่อย ๆ — บันทึกอย่างน้อยทุกเท่านี้ */
const PERSIST_MAX_WAIT_MS = 3000;
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

/** แชทที่โหลดมาจากที่เก็บ — ไม่มีเลยก็เริ่มแชทใหม่ */
function initialState(stored: StoredSessions, lang: string): InitialState {
  const sessions = stored.sessions.length > 0 ? stored.sessions : [createNewSession(lang)];
  const activeId = sessions.some((s) => s.id === stored.activeId) ? stored.activeId! : sessions[0].id;
  return { sessions, activeId };
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
  /** บันทึกแชทลงเครื่องไม่สำเร็จ (null = ปกติ) */
  saveError: string | null;
}

export function useChatSessions(
  stored: StoredSessions,
  settings: AppSettings,
  agentServiceRef: React.RefObject<MultiProviderAgentService | null>,
  /** getter (ไม่ใช่ค่า) เพื่อให้ได้สถานะล่าสุดเสมอ ไม่ล้า 1 render */
  getIsRunning: () => boolean,
  onStopExecution: () => void,
  onClearTerminal?: () => void
): UseChatSessionsReturn {
  const [initial] = useState(() => initialState(stored, settings.language));
  const [sessions, setSessions] = useState<ChatSession[]>(initial.sessions);
  const [currentSessionId, setCurrentSessionId] = useState<string>(initial.activeId);
  const initialSession = initial.sessions.find((s) => s.id === initial.activeId);
  const [messages, setMessages] = useState<ChatMessage[]>(initialSession?.messages ?? []);
  const [sessionTokens, setSessionTokens] = useState<number>(initialSession?.sessionTokens ?? 0);
  const [lastTokenUsage, setLastTokenUsage] = useState<TokenUsage | null>(null);

  /**
   * ให้ agent รู้ประวัติของแชท: ใส่แบบ text-only ทันที (ส่งข้อความได้เลย) แล้วแทนด้วยประวัติเต็ม
   * จากไฟล์ (รวม tool call/result) เมื่อโหลดเสร็จ — ถ้าผู้ใช้ส่งข้อความไปก่อน agent จะไม่รับของที่มาช้า
   */
  const loadAgentHistory = (session: ChatSession | undefined) => {
    const agent = agentServiceRef.current;
    if (!agent) return;
    agent.setHistory(toHistoryPayload(session?.messages ?? []));
    if (!session || session.messages.length === 0) return;
    const version = agent.historyVersion;
    tauriBridge
      .loadSessionHistory(session.id)
      .then((json) => {
        if (json) agent.restoreHistory(json, version);
      })
      .catch((e) => console.warn('Failed to load chat history:', e));
  };

  const forgetAgentHistory = (sessionId: string) =>
    tauriBridge.deleteSessionHistory(sessionId).catch((e) => console.warn('Failed to delete chat history:', e));

  const [saveError, setSaveError] = useState<string | null>(null);
  // แชทที่บันทึกแล้ว เทียบด้วย reference (แชทถูกแทนด้วย object ใหม่ทุกครั้งที่เปลี่ยน) — เขียนเฉพาะแชทที่เปลี่ยน
  const savedRef = useRef(new Map(initial.sessions.map((s) => [s.id, s])));
  // เขียนทีละงานตามลำดับ: ถ้าเขียนไฟล์เดียวกันซ้อนกัน ตัวเก่าที่เสร็จทีหลังจะทับของใหม่
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const latestSessionsRef = useRef(sessions);
  latestSessionsRef.current = sessions;

  const enqueueSave = useCallback((job: () => Promise<void>) => {
    saveQueueRef.current = saveQueueRef.current.then(job).catch((e) => console.error('Chat save queue failed:', e));
  }, []);

  const persist = useCallback(() => {
    enqueueSave(async () => {
      const dirty = latestSessionsRef.current.filter((s) => savedRef.current.get(s.id) !== s);
      if (dirty.length === 0) return;
      const store = sessionStore();
      const results = await Promise.allSettled(dirty.map((s) => store.save(s)));
      let failure: unknown = null;
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') savedRef.current.set(dirty[i].id, dirty[i]);
        else failure ??= r.reason;
      });
      // แชทที่บันทึกไม่ได้ยังนับว่า "เปลี่ยน" จึงถูกลองใหม่ในรอบถัดไป
      if (failure) console.error('Failed to save chat sessions:', failure);
      setSaveError(failure ? String((failure as Error)?.message ?? failure) : null);
    });
  }, [enqueueSave]);

  const forgetSession = (sessionId: string) => {
    savedRef.current.delete(sessionId);
    void forgetAgentHistory(sessionId);
    enqueueSave(() => sessionStore().remove(sessionId));
  };

  // ครั้งเดียวตอนเปิดแอป — สลับแชทหลังจากนี้โหลดผ่าน activate()
  useEffect(() => {
    loadAgentHistory(initialSession);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (currentSessionId) localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, currentSessionId);
  }, [currentSessionId]);

  // บันทึกแบบ debounce (ระหว่างสตรีม messages เปลี่ยนทุก ~40ms) แต่ไม่รอนานเกิน PERSIST_MAX_WAIT_MS
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstUnsavedAtRef = useRef<number | null>(null);
  useEffect(() => {
    const now = Date.now();
    firstUnsavedAtRef.current ??= now;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    const wait = Math.max(0, Math.min(PERSIST_DEBOUNCE_MS, firstUnsavedAtRef.current + PERSIST_MAX_WAIT_MS - now));
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      firstUnsavedAtRef.current = null;
      persist();
    }, wait);
  }, [sessions, persist]);

  useEffect(() => {
    window.addEventListener('beforeunload', persist);
    return () => {
      window.removeEventListener('beforeunload', persist);
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      persist();
    };
  }, [persist]);

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
    loadAgentHistory(session);
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
    forgetSession(sessionId);
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
    void forgetAgentHistory(currentSessionId);
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
    saveError,
  };
}
