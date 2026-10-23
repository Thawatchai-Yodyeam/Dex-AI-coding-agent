import { tauriBridge, type SkillInfo } from '../tauriBridge';
import type { ToolDefinition } from './types';

/**
 * Skills = โฟลเดอร์ที่มี SKILL.md (frontmatter `name` + `description` แล้วตามด้วยคำสั่ง) แบบเดียวกับ Agent Skills
 * - system prompt บอกแค่ชื่อ + คำอธิบาย (ประหยัด context) แล้วโมเดลเรียก use_skill เมื่อจำเป็น
 * - ผู้ใช้เรียกตรง ๆ ได้ด้วย `/ชื่อ-skill ข้อความ` ในช่องแชท
 */

export const SKILL_ROOTS_HINT = '.dex/skills/<name>/SKILL.md (workspace), .claude/skills/<name>/SKILL.md, ~/.dex/skills/<name>/SKILL.md';

/** ตัด frontmatter (`--- ... ---`) ออก เหลือเฉพาะคำสั่ง */
export function stripFrontmatter(text: string): string {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(body);
  return (match ? body.slice(match[0].length) : body).trim();
}

export async function loadSkills(cwd: string): Promise<SkillInfo[]> {
  try {
    return await tauriBridge.listSkills(cwd);
  } catch {
    // รันนอก Tauri (เทสต์/เบราว์เซอร์) หรืออ่านโฟลเดอร์ไม่ได้ — ถือว่าไม่มี skill
    return [];
  }
}

export const USE_SKILL_TOOL: ToolDefinition = {
  name: 'use_skill',
  description:
    'Load the full instructions of one of the available skills listed in the system prompt. Call it before working on a task that matches a skill description, then follow the instructions. Pass `file` to read another file that the skill instructions refer to (relative to the skill folder).',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name exactly as listed' },
      file: { type: 'string', description: 'Optional file inside the skill folder, e.g. reference.md' },
    },
    required: ['name'],
  },
};

/** ส่วนของ system prompt ที่บอกว่ามี skill อะไรบ้าง */
export function skillsPromptSection(skills: SkillInfo[]): string {
  if (skills.length === 0) return '';
  const list = skills.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n');
  return `

Skills (specialised instructions you can load with use_skill when a task matches):
<skills>
${list}
</skills>`;
}

/** อ่านคำสั่งของ skill (หรือไฟล์อื่นในโฟลเดอร์) */
export async function readSkill(skill: SkillInfo, cwd: string, file?: string): Promise<string> {
  const text = await tauriBridge.readSkillFile(skill.dir, file, cwd);
  return file ? text : stripFrontmatter(text);
}

/** ข้อความที่แนบหน้าข้อความผู้ใช้เมื่อเรียก `/skill` เอง — โมเดลไม่ต้องเสีย step ไปเรียก use_skill */
export function skillInvocationBlock(skill: SkillInfo, instructions: string): string {
  return `[The user invoked the "${skill.name}" skill. Its folder is ${skill.dir}. Follow these instructions for this request.]
<skill name="${skill.name}">
${instructions}
</skill>`;
}

/** `/ชื่อ ข้อความ` → skill ที่ตรงชื่อ (ไม่สนตัวพิมพ์) */
export function matchSkillCommand(prompt: string, skills: SkillInfo[]): { skill: SkillInfo; rest: string } | null {
  const m = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
  if (!m) return null;
  const skill = skills.find((s) => s.name.toLowerCase() === m[1].toLowerCase());
  return skill ? { skill, rest: (m[2] ?? '').trim() } : null;
}
