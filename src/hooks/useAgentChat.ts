import { useState, useRef, useCallback } from 'react';
import { tauriBridge } from '../services/tauriBridge';
import { AgentAbortError, type MultiProviderAgentService } from '../services/agent';
import type { AppSettings, ApprovalDecision, ChatMessage, PermissionRule, TokenUsage, ToolCallRecord } from '../types/agent';
import { PROVIDERS_CATALOG, effectiveEffort } from '../types/agent';

export interface UseAgentChatProps {
  settings: AppSettings;
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
  isRunning: boolean;
  isRunningRef: React.MutableRefObject<boolean>;
  activeCommandId: string | null;
  setActiveCommandId: React.Dispatch<React.SetStateAction<string | null>>;
  handleSendMessage: (textToSend?: string) => Promise<void>;
  handleStopExecution: () => void;
  handleApproveTool: (toolId: string, decision?: Exclude<ApprovalDecision, 'reject'>) => void;
  handleRejectTool: (toolId: string) => void;
}

const STREAM_FLUSH_MS = 40;

function helpMessage(settings: AppSettings): string {
  const provider = PROVIDERS_CATALOG.find((p) => p.id === settings.provider);
  const isEn = settings.language === 'en';
  return [
    '### Dex Agent',
    `- **${isEn ? 'Provider' : 'ผู้ให้บริการ'}:** \`${provider?.name ?? settings.provider}\` (${settings.model})`,
    `- **Effort:** \`${effectiveEffort(settings)}\``,
    `- **Workspace:** \`${settings.cwd || '-'}\``,
    `- **${isEn ? 'Commands' : 'คำสั่ง'}:**`,
    `  - \`/clear\` — ${isEn ? 'clear this conversation' : 'ล้างการสนทนานี้'}`,
    `  - \`/help\` — ${isEn ? 'show this help' : 'แสดงวิธีใช้'}`,
  ].join('\n');
}

export function useAgentChat({
  settings,
  agentServiceRef,
  setMessages,
  setSessionTokens,
  setLastTokenUsage,
  onOpenSettings,
  onClearChat,
  onAddPermissionRule,
}: UseAgentChatProps): UseAgentChatReturn {
  const [inputPrompt, setInputPrompt] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [activeCommandId, setActiveCommandId] = useState<string | null>(null);

  // ref คู่กับ state: เช็คแบบ synchronous กันการกดส่งซ้อนใน tick เดียวกัน
  const isRunningRef = useRef(false);
  const activeCommandIdRef = useRef<string | null>(null);
  const approvalResolversRef = useRef<Map<string, (decision: ApprovalDecision) => void>>(new Map());
  const abortControllerRef = useRef<AbortController | null>(null);

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

  const handleSendMessage = async (textToSend?: string) => {
    const prompt = (textToSend ?? inputPrompt).trim();
    if (!prompt || isRunningRef.current) return;

    // Slash commands ใช้ได้แม้ยังไม่มี API key
    if (prompt === '/clear') {
      setInputPrompt('');
      onClearChat();
      return;
    }
    if (prompt === '/help') {
      setInputPrompt('');
      setMessages((prev) => [
        ...prev,
        { id: `msg-${Date.now()}`, role: 'assistant', content: helpMessage(settings), timestamp: Date.now() },
      ]);
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

    const now = Date.now();
    const assistantMsgId = `asst-${now}`;
    setMessages((prev) => [
      ...prev,
      { id: `user-${now}`, role: 'user', content: prompt, timestamp: now },
      { id: assistantMsgId, role: 'assistant', content: '', thought: '', toolCalls: [], timestamp: now },
    ]);

    const updateAssistant = (fn: (msg: ChatMessage) => ChatMessage) =>
      setMessages((prev) => prev.map((msg) => (msg.id === assistantMsgId ? fn(msg) : msg)));

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
        prompt,
        {
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

  return {
    inputPrompt,
    setInputPrompt,
    isRunning,
    isRunningRef,
    activeCommandId,
    setActiveCommandId,
    handleSendMessage,
    handleStopExecution,
    handleApproveTool,
    handleRejectTool,
  };
}
