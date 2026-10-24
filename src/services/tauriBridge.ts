import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { FileItem, ShellOutputEventPayload } from '../types/agent';

export interface FileSlice {
  /** บรรทัดที่อ่านได้ นำหน้าด้วยเลขบรรทัด + tab */
  content: string;
  start_line: number;
  /** 0 = ไม่มีบรรทัดในช่วงที่ขอ */
  end_line: number;
  total_lines: number;
  truncated_lines: number;
}

export interface SkillInfo {
  name: string;
  description: string;
  /** โฟลเดอร์ของ skill */
  dir: string;
  source: 'workspace' | 'user';
}

export interface WebPage {
  /** URL สุดท้ายหลังตาม redirect ภายในโดเมนเดียวกัน */
  url: string;
  status: number;
  content_type: string;
  title: string | null;
  /** HTML ถูกแปลงเป็นข้อความแล้ว */
  content: string;
  /** หน้าใหญ่เกิน 3 MB — ได้แค่ส่วนต้น */
  truncated: boolean;
  /** redirect ไปโดเมนอื่น (ไม่ได้ตามให้) */
  redirect: string | null;
}

export interface FileEdit {
  target_content: string;
  replacement_content: string;
  replace_all?: boolean;
}

export const tauriBridge = {
  async getInitialEnv(): Promise<{ cwd: string; apiKey: string; keys?: Record<string, string>; platform: string }> {
    try {
      return await invoke('get_initial_env');
    } catch (e) {
      console.warn('Tauri get_initial_env not available:', e);
      return { cwd: '', apiKey: '', platform: 'win32' };
    }
  },

  /** API key ที่เก็บใน Windows Credential Manager (throw = ใช้ keyring ไม่ได้ เช่น รันในเบราว์เซอร์) */
  async loadApiKeys(providers: string[]): Promise<Record<string, string>> {
    return await invoke('load_api_keys', { providers });
  },

  /** key ว่าง = ลบออกจาก Credential Manager */
  async saveApiKey(provider: string, key: string): Promise<void> {
    await invoke('save_api_key', { provider, key });
  },

  /** เปิด MCP server แบบ stdio — ข้อความที่ server ส่งมาจะออกทาง onMcpEvent('mcp-message') */
  async mcpStart(id: string, command: string, args: string[], env: Record<string, string>, cwd?: string): Promise<number> {
    return await invoke('mcp_start', { id, command, args, env, cwd });
  },

  async mcpSend(id: string, message: string): Promise<void> {
    await invoke('mcp_send', { id, message });
  },

  async mcpStop(id: string): Promise<void> {
    await invoke('mcp_stop', { id });
  },

  /** POST ผ่าน Rust (ไม่ติด CORS) — `${VAR}` ใน url/header ถูกแทนด้วย environment variable */
  async mcpHttpRequest(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeoutMs?: number
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return await invoke('mcp_http_request', { url, headers, body, timeoutMs });
  },

  async onMcpEvent(
    event: 'mcp-message' | 'mcp-stderr' | 'mcp-exit',
    callback: (payload: { id: string; text: string }) => void
  ): Promise<UnlistenFn> {
    return await listen<{ id: string; text: string }>(event, (e) => callback(e.payload));
  },

  async listSkills(workspace?: string): Promise<SkillInfo[]> {
    return await invoke('list_skills', { workspace });
  },

  /** file ว่าง = SKILL.md */
  async readSkillFile(dir: string, file?: string, workspace?: string): Promise<string> {
    return await invoke('read_skill_file', { dir, file, workspace });
  },

  /** ประวัติแบบ native ของแชท (JSON) เก็บเป็นไฟล์ใน app data */
  async saveSessionHistory(sessionId: string, data: string): Promise<void> {
    await invoke('save_session_history', { sessionId, data });
  },

  async loadSessionHistory(sessionId: string): Promise<string | null> {
    return await invoke('load_session_history', { sessionId });
  },

  async deleteSessionHistory(sessionId: string): Promise<void> {
    await invoke('delete_session_history', { sessionId });
  },

  /** ข้อความที่หน้าจอแชทแสดง (ChatSession เป็น JSON) หนึ่งไฟล์ต่อแชท */
  async saveChatSession(sessionId: string, data: string): Promise<void> {
    await invoke('save_chat_session', { sessionId, data });
  },

  /** JSON ของทุกแชทที่บันทึกไว้ (ไม่เรียงลำดับ) */
  async loadChatSessions(): Promise<string[]> {
    return await invoke('load_chat_sessions');
  },

  async deleteChatSession(sessionId: string): Promise<void> {
    await invoke('delete_chat_session', { sessionId });
  },

  async checkSecurity(
    command: string,
    workspace?: string
  ): Promise<{ safe: boolean; reason?: string; high_risk: boolean; is_read_only: boolean; has_chaining: boolean }> {
    try {
      return await invoke('check_security', { command, workspace });
    } catch (e) {
      // fail closed: ถ้าตรวจไม่ได้ ให้ถือว่าเสี่ยงและต้องขออนุมัติเสมอ (และไม่ให้กฎ allow ข้ามได้)
      console.warn('check_security failed:', e);
      return { safe: true, reason: 'Security check unavailable', high_risk: true, is_read_only: false, has_chaining: true };
    }
  },

  async executeCommand(
    id: string,
    command: string,
    cwd?: string,
    timeoutSecs?: number
  ): Promise<{ success: boolean; exit_code: number; stdout: string; stderr: string }> {
    return await invoke('execute_command', { id, command, cwd, timeoutSecs: timeoutSecs || 120 });
  },

  /** รันคำสั่งเบื้องหลัง คืนทันที — output สตรีมเข้า Terminal และสะสมไว้ให้ readBackgroundOutput */
  async startBackgroundCommand(id: string, command: string, cwd?: string): Promise<number> {
    return await invoke('start_background_command', { id, command, cwd });
  },

  /** output ใหม่ตั้งแต่อ่านครั้งก่อน (throw ถ้าไม่มีคำสั่งเบื้องหลัง id นี้) */
  async readBackgroundOutput(
    id: string
  ): Promise<{ output: string; dropped_bytes: number; running: boolean; exit_code: number | null }> {
    return await invoke('read_background_output', { id });
  },

  async killCommand(id: string): Promise<boolean> {
    try {
      return await invoke('kill_command', { id });
    } catch {
      return false;
    }
  },

  /** allowSensitive = ผู้ใช้อนุญาตให้แตะไฟล์ลับ (.env ฯลฯ) แล้ว — ไม่งั้นฝั่ง Rust ตอบ SENSITIVE_FILE error */
  async readFile(path: string, workspace?: string, allowSensitive = false): Promise<string> {
    return await invoke('read_file', { path, workspace, allowSensitive });
  },

  async writeFile(path: string, content: string, workspace?: string, allowSensitive = false): Promise<string> {
    return await invoke('write_file', { path, content, workspace, allowSensitive });
  },

  async listDir(path: string, workspace?: string): Promise<FileItem[]> {
    return await invoke('list_dir', { path, workspace });
  },

  /** อ่านไฟล์เป็นช่วงบรรทัด (มีเลขบรรทัดนำหน้า) — ใช้กับ tool read_file */
  async readFileLines(
    path: string,
    workspace: string | undefined,
    allowSensitive: boolean,
    range: { offset?: number; limit?: number; maxChars?: number }
  ): Promise<FileSlice> {
    return await invoke('read_file_lines', { path, workspace, allowSensitive, ...range });
  },

  /** แก้ไฟล์หลายจุดแบบ atomic — edit ไหนไม่เจอ/ซ้ำ ไฟล์จะไม่ถูกแตะเลย */
  async editFile(
    path: string,
    edits: FileEdit[],
    workspace?: string,
    allowSensitive = false
  ): Promise<{ success: boolean; message: string; occurrences: number }> {
    return await invoke('edit_file', { path, edits, workspace, allowSensitive });
  },

  /** เนื้อหาไฟล์ก่อนถูกแก้ (null = ไฟล์ยังไม่มี) — ใช้ทำ checkpoint สำหรับ undo */
  async snapshotFile(path: string, workspace?: string, allowSensitive = false): Promise<string | null> {
    return await invoke('snapshot_file', { path, workspace, allowSensitive });
  },

  /** snapshot ทั้ง workspace ด้วย git (ไม่แตะ index ของผู้ใช้) — null = ไม่ใช่ git repo */
  async gitSnapshot(workspace?: string): Promise<string | null> {
    return await invoke('git_snapshot', { workspace });
  },

  /** ย้อน workspace กลับไปตาม snapshot (ยกเว้นไฟล์ใน .gitignore) คืนพาธที่เปลี่ยน */
  async gitRestoreSnapshot(workspace: string | undefined, tree: string): Promise<string[]> {
    return await invoke('git_restore_snapshot', { workspace, tree });
  },

  /** ย้อนไฟล์ตาม checkpoint — content = null คือลบไฟล์ที่ agent สร้างใหม่ */
  async restoreFile(path: string, content: string | null, workspace?: string): Promise<string> {
    return await invoke('restore_file', { path, content, workspace });
  },

  async grepSearch(
    query: string,
    caseInsensitive?: boolean,
    maxResults?: number,
    workspace?: string,
    options: { regex?: boolean; include?: string } = {}
  ): Promise<Array<{ file: string; line_number: number; line_content: string }>> {
    return await invoke('grep_search', {
      query,
      caseInsensitive,
      maxResults,
      workspace,
      ...options,
    });
  },

  async findFiles(pattern: string, workspace?: string): Promise<string[]> {
    return await invoke('find_files', { pattern, workspace });
  },

  /** GET หน้าเว็บผ่าน Rust (ไม่ติด CORS) — HTML ถูกแปลงเป็นข้อความ */
  async webFetch(url: string): Promise<WebPage> {
    return await invoke('web_fetch', { url });
  },

  async selectFolder(): Promise<string | null> {
    try {
      const selected = await invoke<string | null>('select_folder');
      return selected || null;
    } catch (e) {
      console.warn('select_folder failed:', e);
      return null;
    }
  },

  async onShellOutput(
    callback: (payload: ShellOutputEventPayload) => void
  ): Promise<UnlistenFn> {
    return await listen<ShellOutputEventPayload>('shell-output', (event) => {
      callback(event.payload);
    });
  },
};
