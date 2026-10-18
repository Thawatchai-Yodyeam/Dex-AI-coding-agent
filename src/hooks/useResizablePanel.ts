import { useState } from 'react';

export interface UseResizablePanelReturn {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  isDraggingSidebar: boolean;
  terminalHeight: number;
  terminalMaximized: boolean;
  isDraggingTerminal: boolean;
  handleSidebarResizeStart: (e: React.MouseEvent) => void;
  handleTerminalResizeStart: (e: React.MouseEvent) => void;
  toggleSidebarCollapse: () => void;
  toggleTerminalMaximize: () => void;
}

/** อ่านตัวเลขจาก localStorage อย่างปลอดภัย (ค่าเพี้ยน/NaN → ค่า default) */
function readStoredNumber(key: string, min: number, max: number, fallback: number): number {
  const n = parseInt(localStorage.getItem(key) ?? '', 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/** ติดตามการลาก — จบเมื่อปล่อยเมาส์ หรือหน้าต่างเสีย focus (ปล่อยนอกหน้าต่าง) */
function trackDrag(onMove: (e: MouseEvent) => void, onEnd: (e?: MouseEvent) => void) {
  const end = (e?: MouseEvent) => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', end);
    window.removeEventListener('blur', blurEnd);
    onEnd(e);
  };
  const blurEnd = () => end();
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', end);
  window.addEventListener('blur', blurEnd);
}

export function useResizablePanel(): UseResizablePanelReturn {
  // Resizable & Collapsible Layout State
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readStoredNumber('dex_sidebar_width', 200, 480, 268));
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    return localStorage.getItem('dex_sidebar_collapsed') === 'true';
  });
  const [isDraggingSidebar, setIsDraggingSidebar] = useState(false);

  const [terminalHeight, setTerminalHeight] = useState<number>(() => readStoredNumber('dex_terminal_height', 120, 700, 260));
  const [terminalMaximized, setTerminalMaximized] = useState(false);
  const [isDraggingTerminal, setIsDraggingTerminal] = useState(false);

  // Sidebar Horizontal Drag Resize
  const handleSidebarResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingSidebar(true);
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const clamp = (x: number) => Math.max(200, Math.min(Math.min(480, Math.floor(window.innerWidth * 0.45)), x));
    let latest = startWidth;
    trackDrag(
      (moveEvent) => {
        latest = clamp(startWidth + moveEvent.clientX - startX);
        setSidebarWidth(latest);
      },
      () => {
        setIsDraggingSidebar(false);
        localStorage.setItem('dex_sidebar_width', String(latest));
      }
    );
  };

  // Terminal Vertical Drag Resize
  const handleTerminalResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingTerminal(true);
    const startY = e.clientY;
    const startHeight = terminalHeight;

    const clamp = (h: number) => Math.max(120, Math.min(Math.max(200, window.innerHeight - 150), h));
    let latest = startHeight;
    trackDrag(
      (moveEvent) => {
        latest = clamp(startHeight + startY - moveEvent.clientY); // ลากขึ้น = สูงขึ้น
        setTerminalHeight(latest);
      },
      () => {
        setIsDraggingTerminal(false);
        localStorage.setItem('dex_terminal_height', String(latest));
      }
    );
  };

  const toggleSidebarCollapse = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('dex_sidebar_collapsed', String(next));
      return next;
    });
  };

  const toggleTerminalMaximize = () => {
    setTerminalMaximized((prev) => !prev);
  };

  return {
    sidebarWidth,
    sidebarCollapsed,
    isDraggingSidebar,
    terminalHeight,
    terminalMaximized,
    isDraggingTerminal,
    handleSidebarResizeStart,
    handleTerminalResizeStart,
    toggleSidebarCollapse,
    toggleTerminalMaximize,
  };
}
