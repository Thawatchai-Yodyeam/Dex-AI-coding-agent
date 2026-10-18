import React, { memo, useEffect, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  TerminalSquare,
  FileText,
  FilePen,
  FolderOpen,
  Search,
  Pencil,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Clock,
  Loader2,
  Undo2,
  ImageIcon,
} from 'lucide-react';
import type { ApprovalDecision, ChatMessage, ToolCallRecord } from '../types/agent';
import type { Translation } from '../utils/i18n';
import { buildMessageSegments } from '../utils/messageSegments';
import { imageSrc } from '../utils/images';
import { DiffViewer } from './DiffViewer';

interface ChatMessageItemProps {
  message: ChatMessage;
  t: Translation;
  isStreaming?: boolean;
  onApproveTool?: (toolId: string, decision: Exclude<ApprovalDecision, 'reject'>) => void;
  onRejectTool?: (toolId: string) => void;
  /** มี checkpoint ในหน่วยความจำให้ย้อน */
  canUndo?: boolean;
  onUndo?: (messageId: string) => void;
}

/** ปุ่มย้อนไฟล์แบบกดสองครั้ง (กันพลาด) — เหมือนปุ่มลบแชท */
const UndoButton: React.FC<{ count: number; t: Translation; onConfirm: () => void }> = ({ count, t, onConfirm }) => {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <button
      type="button"
      className={`undo-btn ${armed ? 'is-armed' : ''}`}
      title={t.undoTurnHint(count)}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
    >
      <Undo2 size={13} aria-hidden="true" />
      {armed ? t.undoTurnConfirm : t.undoTurn}
    </button>
  );
};

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      })
      .catch((err) => console.warn('Clipboard write failed:', err));
  };
  return [copied, copy];
}

const CodeBlock: React.FC<{ language?: string; code: string; t: Translation }> = ({ language, code, t }) => {
  const [copied, copy] = useCopy();
  return (
    <div className="code-block">
      <div className="code-block-header">
        <span>{language || 'text'}</span>
        <button type="button" className="code-copy" onClick={() => copy(code)}>
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          {copied ? t.copiedCode : t.copyCode}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
};

function markdownComponents(t: Translation): Components {
  return {
    // react-markdown v10 ไม่มี prop `inline` แล้ว: block code = <pre><code>, inline = <code> เดี่ยว
    pre({ children }) {
      const child = React.Children.only(children) as React.ReactElement<{ className?: string; children?: React.ReactNode }>;
      const lang = /language-([\w-]+)/.exec(child?.props?.className || '')?.[1];
      const code = String(child?.props?.children ?? '').replace(/\n$/, '');
      return <CodeBlock language={lang} code={code} t={t} />;
    },
    code({ children, className }) {
      return <code className={className ? className : 'inline-code'}>{children}</code>;
    },
    // ลิงก์เปิดในเบราว์เซอร์ของระบบ ไม่ให้ webview ของแอปนำทางออกไป
    a({ href, children }) {
      return (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            if (href && /^https?:\/\//i.test(href)) {
              openUrl(href).catch((err) => console.warn('openUrl failed:', err));
            }
          }}
        >
          {children}
        </a>
      );
    },
  };
}

const TOOL_ICONS: Record<string, React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>> = {
  run_shell_command: TerminalSquare,
  read_file: FileText,
  write_file: FilePen,
  replace_file_content: Pencil,
  list_directory: FolderOpen,
  grep_search: Search,
  find_files: Search,
};

const ToolCard: React.FC<{
  tool: ToolCallRecord;
  t: Translation;
  onApprove?: (decision: Exclude<ApprovalDecision, 'reject'>) => void;
  onReject?: () => void;
}> = ({ tool, t, onApprove, onReject }) => {
  const [expanded, setExpanded] = useState(false);
  const Icon = TOOL_ICONS[tool.name] ?? FileText;
  const pending = tool.status === 'pending_approval';
  const summary = tool.args.command || tool.args.path || tool.args.query || tool.args.pattern || '';
  const isEdit = tool.name === 'replace_file_content';
  const showDiff = isEdit && typeof tool.args.target_content === 'string';
  const open = expanded || pending;

  const statusText: Record<ToolCallRecord['status'], string> = {
    running: t.toolRunning,
    completed: tool.output && tool.name !== 'run_shell_command' && tool.name !== 'write_file' && !isEdit ? tool.output : t.toolSuccess,
    failed: t.toolFailed,
    rejected: t.toolRejected,
    pending_approval: t.toolPending,
  };

  return (
    <div className={`tool-card status-${tool.status}`}>
      <button
        type="button"
        className="tool-row"
        aria-expanded={open}
        onClick={() => setExpanded((v) => !v)}
      >
        <Icon size={16} aria-hidden={true} />
        <span className="tool-name">{t.toolNames[tool.name] ?? tool.name}</span>
        <code className="tool-summary">{summary}</code>
        <span className="tool-status">
          {tool.status === 'running' && <Loader2 size={13} className="spin" aria-hidden="true" />}
          {statusText[tool.status]}
        </span>
        {open ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
      </button>

      {open && (
        <div className="tool-body">
          {tool.name === 'run_shell_command' && tool.args.command && (
            <pre className="tool-command">
              <span className="prompt-sign" aria-hidden="true">PS&gt; </span>
              {tool.args.command}
            </pre>
          )}
          {showDiff && (
            <DiffViewer
              filePath={tool.args.path}
              originalText={tool.args.target_content}
              replacementText={tool.args.replacement_content ?? ''}
            />
          )}
          {tool.name === 'write_file' && pending && typeof tool.args.content === 'string' && (
            <DiffViewer filePath={tool.args.path} originalText="" replacementText={tool.args.content} />
          )}
          {tool.output && tool.name === 'run_shell_command' && <pre className="tool-output">{tool.output}</pre>}
          {tool.error && <div className="tool-error">{tool.error}</div>}
        </div>
      )}

      {pending && (
        <div className="approval-bar">
          <div className="approval-text">
            <span>{t.approvalPrompt}</span>
            {tool.approvalReason && <span className="approval-reason">{t.approvalReasons[tool.approvalReason]}</span>}
            {tool.suggestedRule && (
              <span className="approval-reason">
                {t.approvalRuleHint} <code>{tool.suggestedRule.pattern}</code>
              </span>
            )}
          </div>
          <div className="approval-actions">
            <button type="button" className="btn btn-secondary" onClick={onReject}>
              {t.rejectBtn}
            </button>
            {tool.suggestedRule && (
              <>
                <button type="button" className="btn btn-secondary" onClick={() => onApprove?.('session')}>
                  {t.approveSessionBtn}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => onApprove?.('always')}>
                  {t.approveAlwaysBtn}
                </button>
              </>
            )}
            <button type="button" className="btn btn-primary" onClick={() => onApprove?.('once')} autoFocus>
              {tool.suggestedRule ? t.approveOnceBtn : t.approveBtn}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/** เวลาที่ผ่านไปนับจาก startedAt — มี timer ของตัวเอง ไม่ทำให้ข้อความทั้งก้อน re-render */
const Elapsed: React.FC<{ startedAt: number }> = ({ startedAt }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <span className="working-time" aria-hidden="true">
      {secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`}
    </span>
  );
};

/**
 * ความคิดของ AI หนึ่งช่วง (หนึ่ง step) — กดเปิดดูได้ทั้งตอนกำลังคิดและหลังคิดเสร็จ
 * ระหว่างกำลังคิด หัวข้อจะเป็นตัวบอกสถานะ (จุดเต้น + shimmer + เวลา) และเนื้อหาเลื่อนตามท้ายอัตโนมัติ
 */
const ThoughtBlock: React.FC<{ thought: string; t: Translation; active: boolean; startedAt: number }> = ({
  thought,
  t,
  active,
  startedAt,
}) => {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // เลื่อนตามท้ายเฉพาะตอนผู้ใช้ไม่ได้เลื่อนขึ้นไปอ่านข้างบน
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && active && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [thought, active, open]);

  return (
    <div className={`thought ${active ? 'is-active' : ''}`}>
      <button type="button" className="thought-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {active ? <span className="working-orb" aria-hidden="true" /> : <Clock size={15} aria-hidden="true" />}
        <span className={active ? 'working-label' : undefined} role={active ? 'status' : undefined}>
          {active ? t.thinking : t.thoughtProcess}
        </span>
        {active && <Elapsed startedAt={startedAt} />}
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      </button>
      {open && (
        <div
          ref={bodyRef}
          className="thought-body"
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {thought}
        </div>
      )}
    </div>
  );
};

/** ป้ายสถานะว่า AI กำลังทำอะไรอยู่ + เวลาที่ผ่านไป */
const WorkingIndicator: React.FC<{ label: string; startedAt: number; paused: boolean }> = ({ label, startedAt, paused }) => (
  <div className={`working ${paused ? 'is-paused' : ''}`}>
    <span className="working-orb" aria-hidden="true" />
    <span className="working-label" role="status">
      {label}
    </span>
    <Elapsed startedAt={startedAt} />
  </div>
);

function workingLabel(message: ChatMessage, t: Translation, lastSegmentIsText: boolean): { label: string; paused: boolean } {
  const tools = message.toolCalls ?? [];
  if (tools.some((tool) => tool.status === 'pending_approval')) return { label: t.workingApproval, paused: true };
  const running = tools.find((tool) => tool.status === 'running');
  if (running) return { label: `${t.toolNames[running.name] ?? running.name}…`, paused: false };
  return { label: lastSegmentIsText ? t.workingWriting : t.thinking, paused: false };
}

const ChatMessageItemImpl: React.FC<ChatMessageItemProps> = ({
  message,
  t,
  isStreaming = false,
  onApproveTool,
  onRejectTool,
  canUndo = false,
  onUndo,
}) => {
  const [copied, copy] = useCopy();

  if (message.role === 'user') {
    const images = message.images ?? [];
    return (
      <div className="msg msg-user">
        {images.length > 0 && (
          <div className="user-images">
            {images.map((img) => {
              const src = imageSrc(img);
              return src ? (
                <img key={img.id} className="user-image" src={src} alt={img.name} title={img.name} />
              ) : (
                <span key={img.id} className="user-image-missing" title={img.name}>
                  <ImageIcon size={14} aria-hidden="true" />
                  {t.imageNotSaved}
                </span>
              );
            })}
          </div>
        )}
        {message.content && <div className="user-bubble">{message.content}</div>}
      </div>
    );
  }

  const tools = message.toolCalls ?? [];
  const segments = buildMessageSegments(message.content, tools, message.thought ?? '');
  const lastSegment = segments[segments.length - 1];
  // ช่วงคิดล่าสุดที่ยังไม่มีอะไรตามหลัง = กำลังคิดอยู่ → หัวข้อของมันเป็นตัวบอกสถานะแทน WorkingIndicator
  const thinkingNow = isStreaming && lastSegment?.kind === 'thought';
  const working = isStreaming && !thinkingNow ? workingLabel(message, t, lastSegment?.kind === 'text') : null;
  const components = markdownComponents(t);
  const checkpoint = message.checkpoint;

  return (
    <div className={`msg msg-assistant ${message.isError ? 'is-error' : ''}`}>
      {segments.map((segment, idx) => {
        if (segment.kind === 'thought') {
          return (
            <ThoughtBlock
              key={`thought-${segment.step}`}
              thought={segment.text}
              t={t}
              active={thinkingNow && idx === segments.length - 1}
              startedAt={message.timestamp}
            />
          );
        }
        if (segment.kind === 'tools') {
          return (
            <div className="tool-list" key={`tools-${segment.step}`}>
              {segment.tools.map((tool) => (
                <ToolCard
                  key={tool.id}
                  tool={tool}
                  t={t}
                  onApprove={onApproveTool ? (decision) => onApproveTool(tool.id, decision) : undefined}
                  onReject={onRejectTool ? () => onRejectTool(tool.id) : undefined}
                />
              ))}
            </div>
          );
        }
        return (
          <div className="markdown" key={`text-${segment.step}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
              {segment.text}
            </ReactMarkdown>
          </div>
        );
      })}

      {working && <WorkingIndicator label={working.label} paused={working.paused} startedAt={message.timestamp} />}

      {!isStreaming && (message.content || checkpoint) && (
        <div className="msg-footer">
          {message.content && (
            <button type="button" className="icon-btn icon-btn-sm" onClick={() => copy(message.content)} aria-label={t.copyMessage} title={t.copyMessage}>
              {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            </button>
          )}
          {checkpoint && checkpoint.files.length > 0 && (
            <span className={`checkpoint-chip ${checkpoint.revertedAt ? 'is-reverted' : ''}`} title={checkpoint.files.join('\n')}>
              <FilePen size={13} aria-hidden="true" />
              <span className="checkpoint-count">{t.filesChanged(checkpoint.files.length)}</span>
              {checkpoint.revertedAt ? ` · ${t.filesReverted}` : ''}
            </span>
          )}
          {checkpoint && !!checkpoint.skipped?.length && (
            <span className="checkpoint-chip is-warning" title={checkpoint.skipped.join('\n')}>
              {t.checkpointSkipped(checkpoint.skipped.length)}
            </span>
          )}
          {canUndo && !checkpoint?.revertedAt && onUndo && (
            <UndoButton count={checkpoint?.files.length ?? 0} t={t} onConfirm={() => onUndo(message.id)} />
          )}
          {message.modelUsed && <span>{message.modelUsed}</span>}
          {message.tokenUsage && (
            <span
              title={`${t.inputTokens}: ${message.tokenUsage.promptTokens.toLocaleString()} · ${t.outputTokens}: ${message.tokenUsage.completionTokens.toLocaleString()}`}
            >
              {message.tokenUsage.totalTokens.toLocaleString()} {t.tokens}
            </span>
          )}
          {!!message.durationMs && <span>{(message.durationMs / 1000).toFixed(1)}s</span>}
        </div>
      )}
    </div>
  );
};

/** memo: ระหว่างสตรีม มีแค่ข้อความล่าสุดที่เปลี่ยน — ไม่ต้อง parse markdown ของทุกข้อความใหม่ */
export const ChatMessageItem = memo(ChatMessageItemImpl);
