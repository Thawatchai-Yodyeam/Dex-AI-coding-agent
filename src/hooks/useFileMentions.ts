import React, { useEffect, useState } from 'react';
import { mentionQueryAt, rankMentionCandidates } from '../services/agent/mentions';
import { tauriBridge } from '../services/tauriBridge';

const SEARCH_DEBOUNCE_MS = 120;

interface ActiveMention {
  /** ตำแหน่งของ `@` ในข้อความ */
  start: number;
  query: string;
}

export interface FileMentions {
  /** แสดงรายการไฟล์ให้เลือก */
  open: boolean;
  items: string[];
  activeIndex: number;
  /** ค้นเสร็จแล้วแต่ไม่เจอไฟล์ที่ตรง */
  noMatch: boolean;
  /** เรียกเมื่อข้อความหรือตำแหน่ง caret เปลี่ยน */
  update: (text: string, caret: number) => void;
  /** true = ปุ่มนี้ถูกใช้กับรายการไฟล์แล้ว (อย่าส่งข้อความ) */
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  pick: (path: string) => void;
  setActiveIndex: (index: number) => void;
}

/**
 * พิมพ์ `@` ในช่องแชทแล้วเลือกไฟล์จาก workspace — เลือกแล้วแทนคำที่พิมพ์ด้วย `@พาธ `
 * (ตอนส่ง useAgentChat แนบเนื้อหาไฟล์เหล่านี้ไปให้ agent)
 */
export function useFileMentions(
  value: string,
  onChange: (value: string) => void,
  cwd: string,
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
): FileMentions {
  const [mention, setMention] = useState<ActiveMention | null>(null);
  const [results, setResults] = useState<{ query: string; items: string[] } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // กด Esc แล้วไม่เปิดรายการซ้ำสำหรับ `@` ตัวเดิม จนกว่าจะพิมพ์ `@` ใหม่
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  const query = mention?.query ?? null;
  useEffect(() => {
    if (query === null || !cwd) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      tauriBridge
        .findFiles(query, cwd)
        .then((paths) => !cancelled && setResults({ query, items: rankMentionCandidates(paths, query) }))
        .catch(() => !cancelled && setResults({ query, items: [] }));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, cwd]);

  // ผลของคำค้นเก่า (ยังค้นคำใหม่ไม่เสร็จ) ยังแสดงได้ ไม่ให้รายการกระพริบระหว่างพิมพ์
  const items = mention && results ? results.items : [];
  const open = items.length > 0;
  const noMatch = !!mention && !!mention.query && results?.query === mention.query && items.length === 0;

  const close = () => {
    setMention(null);
    setResults(null);
  };

  const update = (text: string, caret: number) => {
    const next = cwd ? mentionQueryAt(text, caret) : null;
    if (!next || next.start === dismissedAt) {
      if (mention) close();
      if (!next) setDismissedAt(null);
      return;
    }
    if (next.start !== mention?.start || next.query !== mention.query) {
      setMention(next);
      setActiveIndex(0);
    }
  };

  const pick = (path: string) => {
    const el = textareaRef.current;
    if (!mention || !el) return;
    const before = value.slice(0, mention.start);
    const after = value.slice(el.selectionStart);
    const insert = `@${path}${after.startsWith(' ') ? '' : ' '}`;
    onChange(before + insert + after);
    close();
    const caret = before.length + insert.length + (after.startsWith(' ') ? 1 : 0);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!mention || e.nativeEvent.isComposing) return false;
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissedAt(mention.start);
      close();
      return true;
    }
    if (!open) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((i) => (i + step + items.length) % items.length);
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      pick(items[Math.min(activeIndex, items.length - 1)]);
      return true;
    }
    return false;
  };

  return { open, items, activeIndex, noMatch, update, handleKeyDown, pick, setActiveIndex };
}
