import { useState, useRef, useCallback, useEffect } from 'react';
import { tauriBridge } from '../services/tauriBridge';
import {
  deleteCheckpoint,
  loadCheckpoints,
  newCheckpoint,
  saveCheckpoint,
  type TurnCheckpoint,
} from '../services/checkpointStore';
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
import { PROVIDERS_CATALOG, effectiveEffort, requiresApiKey } from '../types/agent';
import { SKILL_ROOTS_HINT, matchSkillCommand, readSkill, skillInvocationBlock } from '../services/agent/skills';
import { attachMentionedFiles } from '../services/agent/mentions';
import type { SkillInfo } from '../services/tauriBridge';
import { translations } from '../utils/i18n';
import { notificationBody, notifyIfAway } from '../utils/notify';

export interface UseAgentChatProps {
  settings: AppSettings;
  /** แชทที่เปิดอยู่ — ประวัติแบบ native ของเทิร์นถูกบันทึกลงไฟล์ของแชทนี้ */
  sessionId: string;
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
  /** มี checkpoint ของเทิร์นนี้ให้ย้อนได้หรือไม่ (รวมที่โหลดกลับมาจากดิสก์หลังเปิดแอปใหม่) */
  canUndoTurn: (messageId: string) => boolean;
  /** ย้อนไฟล์ทั้งหมดที่ agent แก้ ตั้งแต่เทิร์นนี้ถึงเทิร์นล่าสุด */
  handleUndoTurn: (messageId: string) => Promise<void>;
  /** ส่งข้อความผู้ใช้ก่อนหน้าคำตอบนี้ใหม่ (ทิ้งคำตอบเดิมและทุกอย่างหลังจากนั้น) */
  handleRegenerate: (assistantMessageId: string) => void;
  /** แก้ข้อความผู้ใช้แล้วส่งใหม่จากจุดนั้น */
  handleEditUser: (userMessageId: string, text: string) => void;
  /** คำสั่งเบื้องหลังที่ agent เปิดไว้และยังไม่จบ (แสดงใน Terminal ให้กดหยุดได้) */
  backgroundCommands: BackgroundCommand[];
  removeBackgroundCommand: (id: string) => void;
}

export interface BackgroundCommand {
  id: string;
  command: string;
}

const STREAM_FLUSH_MS = 40;

function helpMessage(settings: AppSettings, instructionsFile: string | undefined, skills: SkillInfo[]): string {
  const provider = PROVIDERS_CATALOG.find((p) => p.id === settings.provider);
  const isEn = settings.language === 'en';
  const none = isEn ? 'none (add DEX.md or AGENTS.md to the workspace root)' : 'ไม่มี (สร้าง DEX.md หรือ AGENTS.md ไว้ที่ราก workspace)';
  const skillLines =
    skills.length > 0
      ? skills.map((s) => `  - \`/${s.name}\` — ${s.description.replace(/\s+/g, ' ').slice(0, 120)}`)
      : [`  - ${isEn ? 'none — add one at' : 'ยังไม่มี — สร้างได้ที่'} \`${SKILL_ROOTS_HINT}\``];
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
    `- **Skills:**`,
    ...skillLines,
  ].join('\n');
}

export function useAgentChat({
  settings,
  sessionId,
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
  const [backgroundCommands, setBackgroundCommands] = useState<BackgroundCommand[]>([]);
  const removeBackgroundCommand = useCallback(
    (id: string) => setBackgroundCommands((prev) => (prev.some((c) => c.id === id) ? prev.filter((c) => c.id !== id) : prev)),
    []
  );

  // ref คู่กับ state: เช็คแบบ synchronous กันการกดส่งซ้อนใน tick เดียวกัน
  const isRunningRef = useRef(false);
  const activeCommandIdRef = useRef<string | null>(null);
  const approvalResolversRef = useRef<Map<string, (decision: ApprovalDecision) => void>>(new Map());
  const abortControllerRef = useRef<AbortController | null>(null);
  // checkpoint ต่อข้อความ assistant — สำเนาอยู่บนดิสก์ด้วย (checkpointStore) จึงย้อนได้หลังปิดแอปหรือแอปล่ม
  const checkpointsRef = useRef<Map<string, TurnCheckpoint>>(new Map());
  // canUndoTurn อ่านจาก ref — ต้อง render ใหม่เมื่อ checkpoint จากดิสก์โหลดเสร็จ
  const [, setCheckpointsLoaded] = useState(0);
  // ข้อความแจ้ง agent ที่จะแนบไปกับ prompt ถัดไป (เช่น ผู้ใช้ย้อนไฟล์แล้ว) — ไม่แสดงใน UI
  const pendingAgentNotesRef = useRef<string[]>([]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

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

  // โหลด checkpoint ของแชทที่เปิดอยู่ — ของที่อยู่ในหน่วยความจำแล้วใหม่กว่าเสมอ (รวมไฟล์ลับที่ไม่ได้ลงดิสก์)
  useEffect(() => {
    let cancelled = false;
    loadCheckpoints(sessionId)
      .then((list) => {
        if (cancelled) return;
        const fresh = list.filter((c) => !checkpointsRef.current.has(c.messageId));
        for (const c of fresh) checkpointsRef.current.set(c.messageId, c);
        if (fresh.length > 0) setCheckpointsLoaded((n) => n + 1);
      })
      .catch((e) => console.warn('Failed to load checkpoints:', e));
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

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
      // 1) snapshot → สภาพก่อนคำสั่ง shell ตัวแรก  2) checkpoint ที่เกิดก่อน snapshot → สภาพก่อนเทิร์น
      let gitRestored = false;
      if (ckpt.git) {
        try {
          for (const path of await tauriBridge.gitRestoreSnapshot(ckpt.cwd, ckpt.git.tree)) restored.add(path);
          gitRestored = true;
        } catch (err: any) {
          failures.push(`git snapshot: ${err?.message || String(err)}`);
        }
      }
      for (const [path, original] of ckpt.originals) {
        if (gitRestored && !ckpt.git!.pathsBefore.has(path)) continue;
        try {
          await tauriBridge.restoreFile(path, original, ckpt.cwd);
          restored.add(path);
        } catch (err: any) {
          failures.push(`\`${path}\`: ${err?.message || String(err)}`);
        }
      }
      // ไฟล์ลับไม่ถูกเขียนลงดิสก์ — หลังเปิดแอปใหม่จึงไม่มีเนื้อหาเดิมให้ย้อน
      for (const path of ckpt.lost) {
        failures.push(
          `\`${path}\`: ${settings.language === 'en' ? 'secret file, its earlier content was not saved to disk' : 'ไฟล์ลับ ไม่ได้บันทึกเนื้อหาเดิมลงดิสก์'}`
        );
      }
      checkpointsRef.current.delete(m.id);
      void deleteCheckpoint(ckpt);
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
      const [instructions, skills] = await Promise.all([
        agentServiceRef.current?.loadProjectInstructions(),
        agentServiceRef.current?.listSkills() ?? [],
      ]);
      appendAssistantNote(helpMessage(settings, instructions?.file, skills));
      return;
    }
    if (prompt === '/undo') {
      setInputPrompt('');
      const last = [...messagesRef.current]
        .reverse()
        .find((m) => checkpointsRef.current.has(m.id) && !m.checkpoint?.revertedAt);
      if (last) await handleUndoTurn(last.id);
      else appendAssistantNote(settings.language === 'en' ? 'Nothing to undo.' : 'ไม่มีการแก้ไฟล์ให้ย้อน');
      return;
    }

    if (!settings.apiKeys[settings.provider]?.trim() && requiresApiKey(settings.provider)) {
      onOpenSettings();
      return;
    }
    const agent = agentServiceRef.current;
    if (!agent) return;

    // `/ชื่อ-skill ข้อความ` → แนบคำสั่งของ skill ไปกับข้อความ (UI แสดงข้อความตามที่ผู้ใช้พิมพ์)
    let skillBlock = '';
    if (prompt.startsWith('/')) {
      const hit = matchSkillCommand(prompt, await agent.listSkills());
      if (hit) {
        try {
          skillBlock = skillInvocationBlock(hit.skill, await readSkill(hit.skill, settings.cwd));
        } catch (err: any) {
          appendAssistantNote(`**Skill \`${hit.skill.name}\`:** ${err?.message || String(err)}`, true);
          return;
        }
      } else if (/^\/[\w-]+$/.test(prompt)) {
        setInputPrompt('');
        appendAssistantNote(
          settings.language === 'en'
            ? `Unknown command \`${prompt}\` — type \`/help\` to see commands and skills.`
            : `ไม่รู้จักคำสั่ง \`${prompt}\` — พิมพ์ \`/help\` เพื่อดูคำสั่งและ skill ที่มี`
        );
        return;
      }
    }

    isRunningRef.current = true;
    setIsRunning(true);
    // ส่งจาก composer เท่านั้นที่ล้างช่องพิมพ์ — regenerate/แก้ข้อความ ต้องไม่ลบสิ่งที่ผู้ใช้พิมพ์ค้างไว้
    if (textToSend === undefined) {
      setInputPrompt('');
      setAttachedImages([]);
    }

    const now = Date.now();
    const userMsgId = `user-${now}`;
    const assistantMsgId = `asst-${now}`;
    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: 'user', content: prompt, timestamp: now, ...(images.length ? { images } : {}) },
      { id: assistantMsgId, role: 'assistant', content: '', thought: '', toolCalls: [], timestamp: now },
    ]);

    const updateAssistant = (fn: (msg: ChatMessage) => ChatMessage) =>
      setMessages((prev) => prev.map((msg) => (msg.id === assistantMsgId ? fn(msg) : msg)));

    // checkpoint ของเทิร์นนี้: จำเนื้อหาก่อนการแก้ครั้งแรกของแต่ละไฟล์เท่านั้น
    const turnCheckpoint = newCheckpoint(sessionId, assistantMsgId, settings.cwd, now);
    const onFileCheckpoint = (path: string, original: string | null | undefined, sensitive = false) => {
      const skipped = original === undefined;
      if (!skipped && !turnCheckpoint.originals.has(path)) {
        turnCheckpoint.originals.set(path, original);
        if (sensitive) turnCheckpoint.memoryOnly.add(path);
        checkpointsRef.current.set(assistantMsgId, turnCheckpoint);
        // เขียนลงดิสก์ทันที ไม่รอจบเทิร์น — แอปล่มกลางเทิร์นคือตอนที่ต้องใช้ undo ที่สุด
        void saveCheckpoint(turnCheckpoint);
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

    // ข้อความผู้ใช้อยู่ท้ายสุดเสมอ — rewindBeforeUserTurn เทียบแบบ "ลงท้ายด้วย"
    // snapshot ครั้งเดียวต่อเทิร์น ก่อนคำสั่ง shell ตัวแรกที่อาจแก้ไฟล์ (workspace ที่ไม่ใช่ git repo = ข้าม)
    let gitSnapshotTried = false;
    const onBeforeShellCommand = async () => {
      if (gitSnapshotTried) return;
      gitSnapshotTried = true;
      const tree = await tauriBridge.gitSnapshot(turnCheckpoint.cwd).catch(() => null);
      if (!tree) return;
      turnCheckpoint.git = { tree, pathsBefore: new Set(turnCheckpoint.originals.keys()) };
      checkpointsRef.current.set(assistantMsgId, turnCheckpoint);
      void saveCheckpoint(turnCheckpoint);
      updateAssistant((msg) => ({ ...msg, checkpoint: { ...(msg.checkpoint ?? { files: [] }), shell: true } }));
    };

    // `@ไฟล์` → แนบเนื้อหาไฟล์ไปกับข้อความ และบอกผู้ใช้ว่าแนบไฟล์ไหนได้บ้าง (พิมพ์พาธผิดจะไม่ขึ้น)
    const mentioned = await attachMentionedFiles(prompt, settings.cwd, settings.permissionRules ?? []).catch(() => null);
    if (mentioned?.files.length) {
      setMessages((prev) => prev.map((m) => (m.id === userMsgId ? { ...m, attachedFiles: mentioned.files } : m)));
    }

    const notes = pendingAgentNotesRef.current.splice(0);
    const agentPrompt = [...notes, skillBlock, mentioned?.block, prompt].filter(Boolean).join('\n\n');

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const turnSessionId = sessionId;
    const notifyEnabled = settings.notifications !== false;

    // รวม chunk ที่ถี่มากให้ render อย่างมากทุก 40ms
    let pendingContent = '';
    let pendingThought = '';
    // แยก "ยังไม่เคยได้ข้อความ" ออกจาก "ข้อความถูกรีเซ็ตเป็นว่าง" (step ที่ลองใหม่ส่งข้อความเดิมกลับมาตั้งแต่ต้น)
    let contentTouched = false;
    let thoughtTouched = false;
    let pendingRetry: ChatMessage['retry'];
    let lastFlush = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      lastFlush = Date.now();
      const content = pendingContent;
      const thought = pendingThought;
      const useContent = contentTouched;
      const useThought = thoughtTouched;
      const retry = pendingRetry;
      updateAssistant((msg) => ({
        ...msg,
        content: useContent ? content : msg.content,
        thought: useThought ? thought : msg.thought,
        retry,
      }));
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
          onBeforeShellCommand,
          onTextChunk: (_chunk, full) => {
            pendingContent = full;
            contentTouched = true;
            pendingRetry = undefined;
            scheduleFlush();
          },
          onThoughtChunk: (_chunk, full) => {
            pendingThought = full;
            thoughtTouched = true;
            pendingRetry = undefined;
            scheduleFlush();
          },
          onCompaction: (phase) => {
            updateAssistant((msg) => ({
              ...msg,
              compaction: phase === 'start' ? 'running' : phase === 'done' ? 'done' : undefined,
            }));
          },
          onRetry: (info) => {
            pendingRetry = { attempt: info.attempt, maxAttempts: info.maxAttempts, reason: info.reason };
            flush();
          },
          onToolStart: (tool) => {
            pendingRetry = undefined;
            flush();
            if (tool.name === 'run_shell_command') setActiveCommand(tool.id);
            upsertTool(tool);
          },
          onToolUpdate: (tool) => {
            flush();
            upsertTool(tool);
            if (tool.name !== 'run_shell_command' || tool.status === 'running' || tool.status === 'pending_approval') return;
            // คำสั่งจบแล้ว (หรือเริ่มเบื้องหลังแล้ว) — ปุ่มหยุดต้องไม่ไปฆ่า dev server ที่รันต่อ
            if (activeCommandIdRef.current === tool.id) setActiveCommand(null);
            const background = tool.args.run_in_background === true || tool.args.run_in_background === 'true';
            if (background && tool.status === 'completed' && tool.exitCode === undefined) {
              const command = String(tool.args.command ?? '');
              setBackgroundCommands((prev) => (prev.some((c) => c.id === tool.id) ? prev : [...prev, { id: tool.id, command }]));
            }
          },
          onRequestApproval: (tool) =>
            new Promise<ApprovalDecision>((resolve) => {
              if (abortController.signal.aborted) return resolve('reject');
              approvalResolversRef.current.set(tool.id, resolve);
              if (notifyEnabled) {
                const t = translations[settings.language];
                const what = String(tool.args.command ?? tool.args.path ?? '');
                notifyIfAway(t.notifyApprovalTitle, `${t.toolNames[tool.name] ?? tool.name}${what ? `: ${what}` : ''}`);
              }
            }),
          onAddPermissionRule,
        },
        abortController.signal
      );
      pendingContent = res.text;
      contentTouched = true;
      pendingRetry = undefined;
      flush();

      if (notifyEnabled) notifyIfAway(translations[settings.language].notifyDoneTitle, notificationBody(res.text));
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
      pendingRetry = undefined;
      flush();
      const isEn = settings.language === 'en';
      const note =
        err instanceof AgentAbortError
          ? `\n\n*${isEn ? '(Stopped by user)' : '(หยุดการทำงานโดยผู้ใช้)'}*`
          : `\n\n**${isEn ? 'Error' : 'ข้อผิดพลาด'}:** ${err?.message || String(err)}`;
      updateAssistant((msg) => ({ ...msg, content: msg.content + note, isError: !(err instanceof AgentAbortError) }));
      // กด Stop เอง = อยู่หน้าจออยู่แล้ว ไม่ต้องแจ้ง
      if (notifyEnabled && !(err instanceof AgentAbortError)) {
        notifyIfAway(translations[settings.language].notifyErrorTitle, notificationBody(err?.message || String(err)));
      }
    } finally {
      if (flushTimer) clearTimeout(flushTimer);
      // บันทึกประวัติแบบ native ของแชทนี้ — ถ้าผู้ใช้สลับแชทไประหว่างเทิร์น ประวัติใน agent เป็นของแชทใหม่แล้ว
      const unchanged = sessionIdRef.current === turnSessionId && agent.historyVersion === agent.lastTurnVersion;
      const snapshot = unchanged ? agent.exportHistory() : null;
      if (snapshot) {
        tauriBridge.saveSessionHistory(turnSessionId, snapshot).catch((e) => console.warn('Failed to save chat history:', e));
      }
      approvalResolversRef.current.clear();
      abortControllerRef.current = null;
      isRunningRef.current = false;
      setIsRunning(false);
      setActiveCommand(null);
    }
  };

  /**
   * ตัดแชทกลับไปก่อนข้อความผู้ใช้ `userId` แล้วส่ง `text` ใหม่จากจุดนั้น (ใช้กับทั้ง regenerate และแก้ข้อความ)
   * ไฟล์ที่ agent แก้ไปแล้วไม่ถูกย้อนอัตโนมัติ — ผู้ใช้ย้อนเองได้ก่อนกดถ้าต้องการ
   */
  const resendFrom = async (userId: string, text: string) => {
    const agent = agentServiceRef.current;
    if (isRunningRef.current || !agent) return;
    const list = messagesRef.current;
    const index = list.findIndex((m) => m.id === userId && m.role === 'user');
    if (index === -1) return;
    const original = list[index];
    const turnsFromEnd = list.slice(index).filter((m) => m.role === 'user').length;
    if (!agent.rewindBeforeUserTurn(original.content, turnsFromEnd)) {
      agent.setHistory(list.slice(0, index).map((m) => ({ role: m.role, content: m.content })));
    }
    const kept = list.slice(0, index);
    for (const m of list.slice(index)) {
      const ckpt = checkpointsRef.current.get(m.id);
      if (!ckpt) continue;
      checkpointsRef.current.delete(m.id);
      void deleteCheckpoint(ckpt);
    }
    messagesRef.current = kept;
    setMessages(kept);
    await handleSendMessage(text, original.images ?? []);
  };

  const handleRegenerate = (assistantId: string) => {
    const list = messagesRef.current;
    const index = list.findIndex((m) => m.id === assistantId);
    const user = [...list.slice(0, index)].reverse().find((m) => m.role === 'user');
    if (index !== -1 && user) void resendFrom(user.id, user.content);
  };

  const handleEditUser = (userId: string, text: string) => {
    if (text.trim()) void resendFrom(userId, text);
  };

  // คงที่ตลอดอายุ component — ChatMessageItem เป็น memo
  const undoTurnRef = useRef(handleUndoTurn);
  undoTurnRef.current = handleUndoTurn;
  const stableUndoTurn = useCallback((messageId: string) => undoTurnRef.current(messageId), []);
  const regenerateRef = useRef(handleRegenerate);
  regenerateRef.current = handleRegenerate;
  const stableRegenerate = useCallback((messageId: string) => regenerateRef.current(messageId), []);
  const editUserRef = useRef(handleEditUser);
  editUserRef.current = handleEditUser;
  const stableEditUser = useCallback((messageId: string, text: string) => editUserRef.current(messageId, text), []);

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
    handleRegenerate: stableRegenerate,
    handleEditUser: stableEditUser,
    backgroundCommands,
    removeBackgroundCommand,
  };
}
