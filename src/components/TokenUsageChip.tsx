import React, { useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { TokenUsage } from '../types/agent';
import type { Translation } from '../utils/i18n';

interface TokenUsageChipProps {
  sessionTokens: number;
  lastTokenUsage?: TokenUsage | null;
  t: Translation;
  onReset?: () => void;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

export const TokenUsageChip: React.FC<TokenUsageChipProps> = ({ sessionTokens, lastTokenUsage, t, onReset }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="token-chip" ref={ref}>
      <button
        type="button"
        className="chip-btn"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        title={t.sessionTokens}
      >
        {formatTokens(sessionTokens)} {t.tokens}
      </button>

      {open && (
        <div className="popover token-popover" role="dialog" aria-label={t.sessionTokens}>
          <div className="popover-label">{t.sessionTokens}</div>
          <div className="popover-value">{sessionTokens.toLocaleString()}</div>
          {lastTokenUsage ? (
            <dl className="token-breakdown">
              <dt>{t.lastRequest}</dt>
              <dd>{lastTokenUsage.totalTokens.toLocaleString()}</dd>
              <dt>{t.inputTokens}</dt>
              <dd>{lastTokenUsage.promptTokens.toLocaleString()}</dd>
              <dt>{t.outputTokens}</dt>
              <dd>{lastTokenUsage.completionTokens.toLocaleString()}</dd>
            </dl>
          ) : (
            <p className="popover-hint">{t.noTokensYet}</p>
          )}
          {onReset && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                onReset();
                setOpen(false);
              }}
            >
              <RotateCcw size={14} aria-hidden="true" />
              {t.resetTokens}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
