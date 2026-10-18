import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { FileItem, ShellOutputEventPayload } from '../types/agent';

export const tauriBridge = {
  async getInitialEnv(): Promise<{ cwd: string; apiKey: string; keys?: Record<string, string>; platform: string }> {
    try {
      return await invoke('get_initial_env');
    } catch (e) {
      console.warn('Tauri get_initial_env not available:', e);
      return { cwd: '', apiKey: '', platform: 'win32' };
    }
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

  async replaceFileContent(
    path: string,
    targetContent: string,
    replacementContent: string,
    workspace?: string,
    allowSensitive = false
  ): Promise<{ success: boolean; message: string; occurrences: number }> {
    return await invoke('replace_file_content', {
      path,
      targetContent,
      replacementContent,
      workspace,
      allowSensitive,
    });
  },

  async grepSearch(
    query: string,
    caseInsensitive?: boolean,
    maxResults?: number,
    workspace?: string
  ): Promise<Array<{ file: string; line_number: number; line_content: string }>> {
    return await invoke('grep_search', {
      query,
      caseInsensitive,
      maxResults,
      workspace,
    });
  },

  async findFiles(pattern: string, workspace?: string): Promise<string[]> {
    return await invoke('find_files', { pattern, workspace });
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
