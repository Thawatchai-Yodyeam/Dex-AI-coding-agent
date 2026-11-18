import type { McpToolRunner } from './tools';

/**
 * โหมดวางแผน: agent อ่านและค้นได้ตามปกติ แต่ห้ามแก้อะไรจนกว่าผู้ใช้จะอนุมัติแผน
 * บังคับตอนรัน tool (ไม่ถอด tool ออกจากรายการที่ส่งให้โมเดล — รายการ tool เปลี่ยนแล้ว prompt cache ของ Claude เริ่มใหม่
 * และ thinking block เก่าใช้ต่อไม่ได้) ส่วนคำสั่ง shell ตัดสินใน handler เพราะต้องรู้ผล checkSecurity ก่อน
 */

/** ข้อความที่โมเดลได้กลับไปเมื่อ tool ถูกกัน */
export const PLAN_MODE_BLOCKED =
  'Plan mode is on, so this was not run: it would change files or state. Keep exploring with read-only tools, then present your plan and wait for the user to approve it.';

/** tool ที่ไม่แก้อะไรเลยไม่ว่าเรียกด้วย argument ไหน (update_todos แค่แสดงรายการในแชท) */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_directory',
  'grep_search',
  'find_files',
  'read_background_output',
  'update_todos',
  'web_fetch',
  'use_skill',
  // subagent อ่านอย่างเดียวในตัวเอง (ดู subagent.ts)
  'subagent',
]);

/** tool ที่มีหลาย action: เฉพาะ action ที่แค่อ่านหรือแค่เปิดดู */
const READ_ONLY_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  browser: new Set(['navigate', 'snapshot', 'screenshot', 'scroll', 'wait', 'console']),
  docx: new Set(['open', 'read']),
  design: new Set(['list', 'open', 'versions', 'comments']),
};

const MCP_TOOL_PREFIX = 'mcp__';

const isTrue = (v: unknown) => v === true || v === 'true';

/**
 * tool นี้ถูกกันในโหมดวางแผนไหม — ตัวที่ผ่านยังต้องผ่านกฎสิทธิ์และการขออนุมัติของตัวเองตามปกติ
 * tool ที่ไม่รู้จักถือว่าแก้ได้ (กันไว้ก่อน)
 */
export function blockedInPlanMode(name: string, args: Record<string, unknown>, mcp?: Pick<McpToolRunner, 'isReadOnly'>): boolean {
  if (name === 'run_shell_command') {
    // คำสั่งเบื้องหลัง (dev server, watcher) เปลี่ยนสถานะเครื่องแม้ตัวคำสั่งจะดูเหมือนอ่านอย่างเดียว
    return isTrue(args.run_in_background ?? args.background);
  }
  if (READ_ONLY_TOOLS.has(name)) return false;
  const actions = READ_ONLY_ACTIONS[name];
  if (actions) {
    const action = typeof args.action === 'string' ? args.action.trim() : '';
    if (!actions.has(action)) return true;
    // เปิดเอกสารใหม่พร้อม discard = ทิ้งการแก้ที่ผู้ใช้ยังไม่ได้บันทึก
    return name === 'docx' && action === 'open' && isTrue(args.discard);
  }
  if (name.startsWith(MCP_TOOL_PREFIX)) return !mcp?.isReadOnly(name);
  return true;
}

/** ข้อความจากแอปที่แนบไปกับข้อความผู้ใช้ของเทิร์นที่อยู่ในโหมดวางแผน */
export const PLAN_MODE_NOTE =
  '[Note from the app: Plan mode is on. Do not change anything in this turn: no file writes or edits, no shell commands that modify files or state, no background commands. ' +
  'Tools that would change something are blocked. Read and search as much as you need, then reply with a concrete plan: what you will change and in which files, in what order, how you will verify it, and anything you are unsure about. ' +
  'If a decision is the user\'s to make, ask it instead of guessing. End your reply after the plan; the user will approve it or ask for changes.]';

/** ผู้ใช้กดอนุมัติแผน */
export const PLAN_APPROVED_NOTE =
  '[Note from the app: The user approved your plan and Plan mode is now off. Carry out the plan. If you find the plan was wrong about something, say so before working around it.]';

/** ผู้ใช้ปิดโหมดวางแผนเองโดยไม่ได้กดอนุมัติ — เทิร์นก่อนหน้าในประวัติยังบอกว่าห้ามแก้ */
export const PLAN_MODE_OFF_NOTE = '[Note from the app: Plan mode is now off. You may change files and run commands again.]';

/**
 * ข้อความเรื่องโหมดวางแผนของเทิร์นนี้ (null = ไม่ต้องบอกอะไร)
 * `previousTurnPlanned` = คำตอบล่าสุดของ agent เกิดในโหมดวางแผน
 */
export function planModeNote(planMode: boolean, previousTurnPlanned: boolean, approved = false): string | null {
  if (planMode) return PLAN_MODE_NOTE;
  if (approved) return PLAN_APPROVED_NOTE;
  return previousTurnPlanned ? PLAN_MODE_OFF_NOTE : null;
}
