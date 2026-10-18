import React from 'react';

/** โลโก้ Dex (โปเกบอล) — ครึ่งบนใช้สี accent ของธีม */
export const DexMark: React.FC<{ size?: number }> = ({ size = 20 }) => (
  <svg className="dex-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M2.5 12a9.5 9.5 0 0 1 19 0z" fill="currentColor" />
    <path d="M2.5 12a9.5 9.5 0 0 0 19 0z" fill="var(--surface)" />
    <g fill="none" stroke="var(--text)" strokeWidth={1.8}>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M2.5 12h6.3M15.2 12h6.3" />
      <circle cx="12" cy="12" r="3.2" fill="var(--surface)" />
    </g>
  </svg>
);
