import type { AppSettings } from '../../types/agent';

/** ไฟล์คำสั่งประจำโปรเจกต์ที่ราก workspace — ใช้ไฟล์แรกที่เจอ */
export const PROJECT_INSTRUCTION_FILES = ['DEX.md', 'AGENTS.md', 'CLAUDE.md'] as const;

export const MAX_PROJECT_INSTRUCTION_CHARS = 20_000;

export interface ProjectInstructions {
  file: string;
  content: string;
}

export function buildSystemPrompt(settings: AppSettings, project?: ProjectInstructions | null): string {
  const languageRule =
    settings.language === 'en'
      ? 'Reply in English.'
      : 'Reply in Thai (ภาษาไทย), concisely and professionally. Keep code, paths and commands as-is.';

  const projectSection = project?.content.trim()
    ? `

Project instructions (from ${project.file} in the workspace root — follow them unless the user says otherwise):
<project_instructions>
${project.content.trim()}
</project_instructions>`
    : '';

  return `You are Dex, an AI coding agent running in a desktop app on Windows.

Environment:
- Shell: PowerShell. Working directory (workspace): ${settings.cwd}
- File tools are sandboxed to the workspace.

How to work:
- Use tools to inspect and act; never guess file contents or command output.
- Explore with find_files and grep_search before opening files.
- Edit existing files with replace_file_content; use write_file only for new files or full rewrites.
- After changing code, verify when practical (run the build or tests).
- Keep explanations short and concrete; reference files as relative paths.
- The user can undo your file edits from the app; if they tell you files were reverted, re-read before editing.${projectSection}

${languageRule}`;
}
