import { useState, useRef, useCallback } from 'react';
import { tauriBridge } from '../services/tauriBridge';
import { AgentAbortError, type MultiProviderAgentService } from '../services/agent';
import type {
  AppSettings,
  ApprovalDecision,
  ChatMessage,
  ImageAttachment,
  PermissionRule,
  TokenUsage,
  ToolCallRecord,
} from '../types/agent';
import { PROVIDERS_CATALOG, effectiveEffort } from '../types/agent';

export interface UseAgentChatProps {
  settings: AppSettings;
  messages: ChatMessage[];
  agentServiceRef: React.RefObject<MultiProviderAgentService | null>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setSessionTokens: React.Dispatch<React.SetStateAction<number>>;
  setLastTokenUsage: React.Dispatch<React.SetStateAction<TokenUsage | null>>;
  onOpenSettings: () => void;
  onClearChat: () => void;
  /** ผู้ใช้กด "อนุญาตเสมอ" บนแถบอนุมัติ */
  onAddPermissionRule: (rule: PermissionRule) => void;
}

export interface UseAgentChatReturn {
  inputPrompt: string;
  setInputPrompt: React.Dispatch<React.SetStateAction<string>>;
  /** รูปที่แนบรอส่งใน composer */
  attachedImages: ImageAttachment[];
  setAttachedImages: React.Dispatch<React.SetStateAction<ImageAttachment[]>>;
  isRunning: boolean;
  isRunningRef: React.MutableRefObject<boolean>;
  activeCommandId: string | null;
  setActiveCommandId: React.Dispatch<React.SetStateAction<string | null>>;
  handleSendMessage: (textToSend?: string, images?: ImageAttachment[]) => Promise<void>;
  handleStopExecution: () => void;
  handleApproveTool: (toolId: string, decision?: Exclude<ApprovalDecision, 'reject'>) => void;
  handleRejectTool: (toolId: string) => void;
  /** มี checkpoint ในหน่วยความจำให้ย้อนได้หรือไม่ */
  canUndoTurn: (messageId: string) => boolean;
  /** ย้อนไฟล์ทั้งหมดที่ agent แก้ ตั้งแต่เทิร์นนี้ถึงเทิร์นล่าสุด */
  handleUndoTurn: (messageId: string) => Promise<void>;
}

/** เนื้อหาเดิมของไฟล์ก่อนเทิร์นหนึ่งแก้ (null = ไฟล์ใหม่) */
interface TurnCheckpoint {
  cwd: string;
  originals: Map<string, string | null>;
}

const STREAM_FLUSH_MS = 40;

function helpMessage(settings: AppSettings, instructionsFile?: string): string {
  const provider = PROVIDERS_CATALOG.find((p) => p.id === settings.provider);
  const isEn = settings.language === 'en';
  const none = isEn ? 'none (add DEX.md or AGENTS.md to the workspace root)' : 'ไม่มี (สร้าง DEX.md หรือ AGENTS.md ไว้ที่ราก workspace)';
  return [
    '### Dex Agent',
    `- **${isEn ? 'Provider' : 'ผู้ให้บริการ'}:** \`${provider?.name ?? settings.provider}\` (${settings.model})`,
    `- **Effort:** \`${effectiveEffort(settings)}\``,
    `- **Workspace:** \`${settings.cwd || '-'}\``,
    `- **${isEn ? 'Project instructions' : 'คำสั่งประจำโปรเจกต์'}:** ${instructionsFile ? `\`${instructionsFile}\`` : none}`,
    `- **${isEn ? 'Commands' : 'คำสั่ง'}:**`,
    `  - \`/clear\` — ${isEn ? 'clear this conversation' : 'ล้างการสนทนานี้'}`,
    `  - \`/undo\` — ${isEn ? 'revert files changed in the last turn' : 'ย้อนไฟล์ที่ agent แก้ในเทิร์นล่าสุด'}`,
    `  - \`/help\` — ${isEn ? 'show this help' : 'แสดงวิธีใช้'}`,
  ].join('\n');
}

export function useAgentChat({
  settings,
  messages,
  agentServiceRef,
  setMessages,
  setSessionTokens,
  setLastTokenUsage,
  onOpenSettings,
  onClearChat,
  onAddPermissionRule,
}: UseAgentChatProps): UseAgentChatReturn {
  const [inputPrompt, setInputPrompt] = useState('');
  const [attachedImages, setAttachedImages] = useState<ImageAttachment[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [activeCommandId, setActiveCommandId] = useState<string | null>(null);

  // ref คู่กับ state: เช็คแบบ synchronous กันการกดส่งซ้อนใน tick เดียวกัน
  const isRunningRef = useRef(false);
  const activeCommandIdRef = useRef<string | null>(null);
  const approvalResolversRef = useRef<Map<string, (decision: ApprovalDecision) => void>>(new Map());
  const abortControllerRef = useRef<AbortController | null>(null);
  // checkpoint ต่อข้อความ assistant — อยู่ในหน่วยความจำเท่านั้น (เนื้อหาไฟล์ใหญ่เกิน localStorage)
  const checkpointsRef = useRef<Map<string, TurnCheckpoint>>(new Map());
  // ข้อความแจ้ง agent ที่จะแนบไปกับ prompt ถัดไป (เช่น ผู้ใช้ย้อนไฟล์แล้ว) — ไม่แสดงใน UI
  const pendingAgentNotesRef = useRef<string[]>([]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const setActiveCommand = useCallback((id: string | null) => {
    activeCommandIdRef.current = id;
    setActiveCommandId(id);
  }, []);

  // handler เหล่านี้อ้างแค่ ref จึงคงที่ตลอดอายุ component — ให้ ChatMessageItem (memo) ไม่ re-render ฟรี
  const resolveApproval = useCallback((toolId: string, decision: ApprovalDecision) => {
    const resolver = approvalResolversRef.current.get(toolId);
    if (resolver) {
      approvalResolversRef.current.delete(toolId);
      resolver(decision);
    }
  }, []);

  const handleStopExecution = useCallback(() => {
    abortControllerRef.current?.abort();
    for (const id of [...approvalResolversRef.current.keys()]) resolveApproval(id, 'reject');
    if (activeCommandIdRef.current) tauriBridge.killCommand(activeCommandIdRef.current);
  }, [resolveApproval]);

  const handleApproveTool = useCallback(
    (toolId: string, decision: Exclude<ApprovalDecision, 'reject'> = 'once') => resolveApproval(toolId, decision),
    [resolveApproval]
  );
  const handleRejectTool = useCallback((toolId: string) => resolveApproval(toolId, 'reject'), [resolveApproval]);

  const canUndoTurn = useCallback((messageId: string) => checkpointsRef.current.has(messageId), []);

  const appendAssistantNote = (content: string, isError = false) =>
    setMessages((prev) => [...prev, { id: `msg-${Date.now()}`, role: 'assistant', content, timestamp: Date.now(), isError }]);

  const handleUndoTurn = async (messageId: string) => {
    if (isRunningRef.current) return;
    const list = messagesRef.current;
    const start = list.findIndex((m) => m.id === messageId);
    if (start === -1) return;
    // ย้อนจากเทิร์นล่าสุดถอยไปถึงเทิร์นที่เลือก — ไฟล์เดียวกันจะจบที่สถานะก่อนเทิร์นที่เลือก
    const turns = list
      .slice(start)
      .filter((m) => checkpointsRef.current.has(m.id))
      .reverse();
    if (turns.length === 0) return;

    const restored = new Set<string>();
    const failures: string[] = [];
    for (const m of turns) {
      const ckpt = checkpointsRef.current.get(m.id)!;
      for (const [path, original] of ckpt.originals) {
        try {
          await tauriBridge.restoreFile(path, original, ckpt.cwd);
          restored.add(path);
        } catch (err: any) {
          failures.push(`\`${path}\`: ${err?.message || String(err)}`);
        }
      }
      checkpointsRef.current.delete(m.id);
    }

    const revertedIds = new Set(turns.map((m) => m.id));
    const now = Date.now();
    setMessages((prev) =>
      prev.map((m) =>
        revertedIds.has(m.id) && m.checkpoint ? { ...m, checkpoint: { ...m.checkpoint, revertedAt: now } } : m
      )
    );

    const files = [...restored];
    if (files.length > 0) {
      pendingAgentNotesRef.current.push(
        `[Note from the app: the user reverted your file changes from the last ${turns.length} turn(s). ` +
          `These files are back to their earlier state: ${files.join(', ')}. Re-read them before editing again.]`
      );
    }
    const isEn = settings.language === 'en';
    const lines = [
      isEn
        ? `↩️ Reverted ${files.length} file(s) to before that turn.`
        : `↩️ ย้อนไฟล์ ${files.length} ไฟล์กลับไปก่อนเทิร์นนั้นแล้ว`,
      ...files.map((f) => `- \`${f}\``),
    ];
    if (failures.length > 0) {
      lines.push('', isEn ? '**Could not restore:**' : '**ย้อนไม่สำเร็จ:**', ...failures.map((f) => `- ${f}`));
    }
    appendAssistantNote(lines.join('\n'), failures.length > 0);
  };

  /** ไม่ส่ง textToSend = ส่งสิ่งที่อยู่ใน composer (รวมรูปที่แนบ); ส่ง textToSend = quick prompt ไม่มีรูป */
  const handleSendMessage = async (
    textToSend?: string,
    images: ImageAttachment[] = textToSend === undefined ? attachedImages : []
  ) => {
    const prompt = (textToSend ?? inputPrompt).trim();
    if ((!prompt && images.length === 0) || isRunningRef.current) return;

    // Slash commands ใช้ได้แม้ยังไม่มี API key
    if (prompt === '/clear') {
      setInputPrompt('');
      onClearChat();
      return;
    }
    if (prompt === '/help') {
      setInputPrompt('');
      const instructions = await agentServiceRef.current?.loadProjectInstructions();
      appendAssistantNote(helpMessage(settings, instructions?.file));
      return;
    }
    if (prompt === '/undo') {
      setInputPrompt('');
      const last = [...messagesRef.current].reverse().find((m) => checkpointsRef.current.has(m.id));
      if (last) await handleUndoTurn(last.id);
      else appendAssistantNote(settings.language === 'en' ? 'Nothing to undo.' : 'ไม่มีการแก้ไฟล์ให้ย้อน');
      return;
    }

    if (!settings.apiKeys[settings.provider]?.trim()) {
      onOpenSettings();
      return;
    }
    const agent = agentServiceRef.current;
    if (!agent) return;

    isRunningRef.current = true;
    setIsRunning(true);
    setInputPrompt('');
    if (textToSend === undefined) setAttachedImages([]);

    const now = Date.now();
    const assistantMsgId = `asst-${now}`;
    setMessages((prev) => [
      ...prev,
      { id: `user-${now}`, role: 'user', content: prompt, timestamp: now, ...(images.length ? { images } : {}) },
      { id: assistantMsgId, role: 'assistant', content: '', thought: '', toolCalls: [], timestamp: now },
    ]);

    const updateAssistant = (fn: (msg: ChatMessage) => ChatMessage) =>
      setMessages((prev) => prev.map((msg) => (msg.id === assistantMsgId ? fn(msg) : msg)));

    // checkpoint ของเทิร์นนี้: จำเนื้อหาก่อนการแก้ครั้งแรกของแต่ละไฟล์เท่านั้น
    const turnCheckpoint: TurnCheckpoint = { cwd: settings.cwd, originals: new Map() };
    const onFileCheckpoint = (path: string, original: string | null | undefined) => {
      const skipped = original === undefined;
      if (!skipped && !turnCheckpoint.originals.has(path)) {
        turnCheckpoint.originals.set(path, original);
        checkpointsRef.current.set(assistantMsgId, turnCheckpoint);
      }
      updateAssistant((msg) => {
        const info = msg.checkpoint ?? { files: [] };
        if (skipped) {
          const list = info.skipped ?? [];
          return list.includes(path) ? msg : { ...msg, checkpoint: { ...info, skipped: [...list, path] } };
        }
        return info.files.includes(path) ? msg : { ...msg, checkpoint: { ...info, files: [...info.files, path] } };
      });
    };

    const notes = pendingAgentNotesRef.current.splice(0);
    const agentPrompt = notes.length > 0 ? `${notes.join('\n')}\n\n${prompt}` : prompt;

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // รวม chunk ที่ถี่มากให้ render อย่างมากทุก 40ms
    let pendingContent = '';
    let pendingThought = '';
    let lastFlush = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      lastFlush = Date.now();
      const content = pendingContent;
      const thought = pendingThought;
      updateAssistant((msg) => ({ ...msg, content: content || msg.content, thought: thought || msg.thought }));
    };
    const scheduleFlush = () => {
      if (Date.now() - lastFlush > STREAM_FLUSH_MS) flush();
      else if (!flushTimer) flushTimer = setTimeout(flush, STREAM_FLUSH_MS);
    };
    // tool ใหม่จำตำแหน่งข้อความ ณ ตอนเริ่ม (หลัง flush แล้ว) เพื่อแสดงแทรกระหว่างข้อความตามลำดับ
    const upsertTool = (tool: ToolCallRecord) => {
      // อ่านค่าตอนนี้ — updater ของ setState อาจถูกเรียกทีหลังตอนที่ pendingContent ยาวขึ้นแล้ว
      const contentOffset = pendingContent.length;
      const thoughtOffset = pendingThought.length;
      updateAssistant((msg) => {
        const list = msg.toolCalls || [];
        const existing = list.find((t) => t.id === tool.id);
        return {
          ...msg,
          toolCalls: existing
            ? list.map((t) =>
                t.id === tool.id
                  ? { ...tool, contentOffset: existing.contentOffset, thoughtOffset: existing.thoughtOffset }
                  : t
              )
            : [...list, { ...tool, contentOffset, thoughtOffset }],
        };
      });
    };

    try {
      const res = await agent.sendMessage(
        { text: agentPrompt, images },
        {
          onFileCheckpoint,
          onTextChunk: (_chunk, full) => {
            pendingContent = full;
            scheduleFlush();
          },
          onThoughtChunk: (_chunk, full) => {
            pendingThought = full;
            scheduleFlush();
          },
          onToolStart: (tool) => {
            flush();
            if (tool.name === 'run_shell_command') setActiveCommand(tool.id);
            upsertTool(tool);
          },
          onToolUpdate: (tool) => {
            flush();
            upsertTool(tool);
          },
          onRequestApproval: (tool) =>
            new Promise<ApprovalDecision>((resolve) => {
              if (abortController.signal.aborted) return resolve('reject');
              approvalResolversRef.current.set(tool.id, resolve);
            }),
          onAddPermissionRule,
        },
        abortController.signal
      );
      pendingContent = res.text;
      flush();

      setLastTokenUsage(res.tokenUsage);
      setSessionTokens((prev) => prev + res.tokenUsage.totalTokens);
      updateAssistant((msg) => ({
        ...msg,
        tokenUsage: res.tokenUsage,
        durationMs: res.durationMs,
        modelUsed: settings.model,
        providerUsed: settings.provider,
      }));
    } catch (err: any) {
      flush();
      const isEn = settings.language === 'en';
      const note =
        err instanceof AgentAbortError
          ? `\n\n*${isEn ? '(Stopped by user)' : '(หยุดการทำงานโดยผู้ใช้)'}*`
          : `\n\n**${isEn ? 'Error' : 'ข้อผิดพลาด'}:** ${err?.message || String(err)}`;
      updateAssistant((msg) => ({ ...msg, content: msg.content + note, isError: !(err instanceof AgentAbortError) }));
    } finally {
      if (flushTimer) clearTimeout(flushTimer);
      approvalResolversRef.current.clear();
      abortControllerRef.current = null;
      isRunningRef.current = false;
      setIsRunning(false);
      setActiveCommand(null);
    }
  };

  // คงที่ตลอดอายุ component — ChatMessageItem เป็น memo
  const undoTurnRef = useRef(handleUndoTurn);
  undoTurnRef.current = handleUndoTurn;
  const stableUndoTurn = useCallback((messageId: string) => undoTurnRef.current(messageId), []);

  return {
    inputPrompt,
    setInputPrompt,
    attachedImages,
    setAttachedImages,
    isRunning,
    isRunningRef,
    activeCommandId,
    setActiveCommandId,
    handleSendMessage,
    handleStopExecution,
    handleApproveTool,
    handleRejectTool,
    canUndoTurn,
    handleUndoTurn: stableUndoTurn,
  };
}
