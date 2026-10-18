import React, { useMemo } from 'react';

interface DiffViewerProps {
  filePath?: string;
  originalText: string;
  replacementText: string;
}

interface DiffLine {
  type: 'removed' | 'added' | 'unchanged';
  content: string;
}

/** ขนาดตาราง LCS สูงสุด (บรรทัดเก่า × ใหม่) ก่อนถอยไปแสดงแบบลบทั้งหมด/เพิ่มทั้งหมด */
const MAX_LCS_CELLS = 250_000;

/** line diff ด้วย LCS — แสดงบรรทัดที่ไม่เปลี่ยนเป็นบริบท แทนการโชว์ทุกบรรทัดเป็น -/+ */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText ? oldText.split(/\r?\n/) : [];
  const b = newText ? newText.split(/\r?\n/) : [];
  if (a.length * b.length > MAX_LCS_CELLS) {
    return [
      ...a.map((content) => ({ type: 'removed' as const, content })),
      ...b.map((content) => ({ type: 'added' as const, content })),
    ];
  }

  const rows = a.length + 1;
  const cols = b.length + 1;
  const lcs = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] =
        a[i] === b[j] ? lcs[(i + 1) * cols + j + 1] + 1 : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'unchanged', content: a[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * cols + j] >= lcs[i * cols + j + 1]) {
      out.push({ type: 'removed', content: a[i++] });
    } else {
      out.push({ type: 'added', content: b[j++] });
    }
  }
  while (i < a.length) out.push({ type: 'removed', content: a[i++] });
  while (j < b.length) out.push({ type: 'added', content: b[j++] });
  return out;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({ filePath, originalText, replacementText }) => {
  const lines = useMemo(() => computeLineDiff(originalText, replacementText), [originalText, replacementText]);
  const removed = lines.filter((l) => l.type === 'removed').length;
  const added = lines.filter((l) => l.type === 'added').length;

  return (
    <div className="diff">
      {filePath && (
        <div className="diff-header">
          <code className="diff-path">{filePath}</code>
          <span className="diff-stat diff-stat-add">+{added}</span>
          <span className="diff-stat diff-stat-del">−{removed}</span>
        </div>
      )}
      <div className="diff-body" role="table" aria-label="diff">
        {lines.map((line, idx) => (
          <div key={idx} className={`diff-line diff-${line.type}`} role="row">
            <span className="diff-marker" aria-hidden="true">
              {line.type === 'removed' ? '-' : line.type === 'added' ? '+' : ' '}
            </span>
            <code className="diff-text">{line.content || ' '}</code>
          </div>
        ))}
      </div>
    </div>
  );
};
