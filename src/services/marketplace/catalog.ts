import {
  CODE_REVIEW_SKILL,
  COMMIT_MESSAGE_SKILL,
  DEBUG_PLAYBOOK_SKILL,
  DOCS_WRITER_SKILL,
  EXPLAIN_CODE_SKILL,
  TEST_WRITER_SKILL,
} from './skillPacks';

/**
 * รายการ plugin ใน Marketplace — plugin หนึ่งตัวคือสิ่งที่แอปรองรับอยู่แล้ว ไม่ใช่ระบบใหม่:
 * - `mcp`: entry ใน config ของ MCP (แบบเดียวกับที่วางเองในตั้งค่า) tool ของมันจึงถามก่อนรันตามกฎเดิม
 * - `skill`: โฟลเดอร์ SKILL.md ใน ~/.dex/skills
 *
 * เพิ่ม plugin: ตรวจว่าแพ็กเกจ/URL มีจริงและรันได้ แล้วเติมที่นี่ — marketplace.test.ts ตรวจความสอดคล้องของข้อมูลให้
 * คีย์ต้องส่งผ่าน `${NAME}` ใน env/headers เสมอ (ห้ามใส่ใน args: จะเห็นใน process list)
 *
 * แพ็กเกจของ npx/uvx ต้องระบุเวอร์ชันตายตัว: server เริ่มเองทุกครั้งที่เปิดแอป ถ้าไม่ pin จะได้โค้ดใหม่มารันโดยไม่มีใครถาม
 * ตอนเปลี่ยนเวอร์ชัน ให้ดูชื่อ flag และตัวแปรจากแพ็กเกจเวอร์ชันนั้นจริง ๆ — README บน GitHub อาจล้ำหน้าเวอร์ชันที่ปล่อยแล้ว
 * และเลือกเวอร์ชันที่ปล่อยมาสักพัก เผื่อเวอร์ชันที่ถูกแฮ็กหรือพังถูกจับได้ก่อน ผู้ที่ติดตั้งไว้จะเห็นปุ่มอัปเดตเอง
 *
 * remoteOauth ใช้ได้เฉพาะ server ที่เอกสารทางการยืนยันและ metadata จริงมี registration_endpoint กับ S256
 * ที่ตรวจแล้วว่าใช้ไม่ได้ (2026-11-05): GitHub และ Asana ไม่มี registration_endpoint, Atlassian v1 ไม่มี protected
 * resource metadata, Figma รับเฉพาะ client ใน catalog ของตัวเอง, Google Workspace แบบ hosted ไม่มี
 * registration_endpoint และผู้ใช้ต้องสร้าง OAuth client เองใน Developer Preview
 */

export interface Localized {
  th: string;
  en: string;
}

export type PluginSectionId = 'essentials' | 'web' | 'build' | 'work' | 'creative' | 'skills';

/** ชื่อไอคอนใน PluginIcon.tsx — ไฟล์นี้เป็นข้อมูลล้วน ไม่ import React */
export type PluginIconName =
  | 'book-open'
  | 'library'
  | 'brain'
  | 'list-tree'
  | 'clock'
  | 'git-branch'
  | 'bug-play'
  | 'theater'
  | 'search'
  | 'telescope'
  | 'flame'
  | 'globe'
  | 'git-pull-request'
  | 'database'
  | 'radar'
  | 'leaf'
  | 'graduation-cap'
  | 'cloud'
  | 'server'
  | 'briefcase'
  | 'notebook-pen'
  | 'list-checks'
  | 'pen-tool'
  | 'box'
  | 'gamepad'
  | 'search-check'
  | 'git-commit'
  | 'flask'
  | 'bug'
  | 'message-question'
  | 'file-text';

export interface PluginSecret {
  /** ชื่อใน `${NAME}` — เก็บใน Credential Manager เป็น mcp-secret-<NAME> */
  name: string;
  label: string;
  /** หน้าที่ใช้สร้างคีย์ */
  helpUrl: string;
}

/** `auth: 'oauth'` = ล็อกอินผ่านเบราว์เซอร์ — ไม่มีคีย์ใน config และ token อยู่ฝั่ง Rust */
export type McpEntry = Record<string, unknown> & { auth?: 'oauth' };

export type PluginInstall =
  | { kind: 'mcp'; server: McpEntry }
  | { kind: 'skill'; skillName: string; summary: string; instructions: string };

export interface MarketplacePlugin {
  /** ชื่อ server ใน config ด้วย — ใช้เป็นส่วนหนึ่งของชื่อ tool จึงต้องเป็น [a-z0-9-] */
  id: string;
  name: string;
  publisher: string;
  /** true = ไม่ได้ทำโดยเจ้าของบริการหรือผู้ดูแล MCP — แสดงป้ายให้ผู้ใช้ชั่งใจก่อนติดตั้ง */
  community?: boolean;
  section: PluginSectionId;
  icon: PluginIconName;
  /** สีของไอคอน */
  color: string;
  description: Localized;
  /** สิ่งที่ต้องทำเพิ่มนอกแอป */
  note?: Localized;
  homepage: string;
  secrets?: PluginSecret[];
  /** คีย์จากรุ่นก่อนที่เปลี่ยนมาใช้ OAuth — ไม่ได้ใช้แล้วแต่ยังอาจค้างใน Credential Manager จึงต้องลบตอนถอนการติดตั้ง */
  legacySecrets?: string[];
  install: PluginInstall;
}

export const PLUGIN_SECTIONS: { id: PluginSectionId; title: Localized; subtitle: Localized }[] = [
  {
    id: 'essentials',
    title: { th: 'ผู้ช่วยพื้นฐาน', en: 'Agent essentials' },
    subtitle: {
      th: 'ความจำ เอกสารของไลบรารี และเครื่องมือที่ใช้ได้กับทุกโปรเจกต์',
      en: 'Memory, library docs and tools that help on every project.',
    },
  },
  {
    id: 'web',
    title: { th: 'เว็บและเบราว์เซอร์', en: 'Web and browser' },
    subtitle: {
      th: 'ค้นเว็บ ดึงข้อมูลจากหน้าเว็บ และสั่งเบราว์เซอร์เพื่อทดสอบเว็บแอป',
      en: 'Search the web, extract pages and drive a browser to test web apps.',
    },
  },
  {
    id: 'build',
    title: { th: 'สร้างและดูแลระบบ', en: 'Build and ship' },
    subtitle: {
      th: 'เชื่อมต่อโค้ด ฐานข้อมูล การติดตาม error และเอกสารของแพลตฟอร์มคลาวด์',
      en: 'Connect your code, databases, error tracking and cloud platform docs.',
    },
  },
  {
    id: 'work',
    title: { th: 'เอกสารและการทำงาน', en: 'Docs and productivity' },
    subtitle: {
      th: 'อ่านและแก้เอกสาร ตาราง และงานดีไซน์ที่ทีมใช้อยู่',
      en: 'Read and edit the documents, sheets and designs your team already uses.',
    },
  },
  {
    id: 'creative',
    title: { th: 'เกมและ 3D', en: 'Games and 3D' },
    subtitle: {
      th: 'ให้ Dex สั่งงานโปรแกรมสร้างเกมและโมเดล 3D ที่เปิดอยู่ในเครื่อง',
      en: 'Let Dex drive the game and 3D tools open on your machine.',
    },
  },
  {
    id: 'skills',
    title: { th: 'ชุด Skill', en: 'Skill packs' },
    subtitle: {
      th: 'คำสั่งสำเร็จรูปสำหรับงานที่ทำบ่อย ไม่มีโปรแกรมรัน เรียกด้วย /ชื่อ-skill ได้เลย',
      en: 'Ready-made instructions for common jobs. Nothing runs; call them with /skill-name.',
    },
  },
];

/** ครั้งแรก npx/uvx ต้องดาวน์โหลดแพ็กเกจ — ค่าเริ่มต้น 60 วินาทีของ initialize ไม่พอบนเน็ตช้า */
const STDIO_TIMEOUT_MS = 300_000;

const secretEnv = (...names: string[]) => Object.fromEntries(names.map((name) => [name, `\${${name}}`]));

const npx = (args: string[], env?: Record<string, string>): McpEntry => ({
  command: 'npx',
  args: ['-y', ...args],
  ...(env ? { env } : {}),
  timeout: STDIO_TIMEOUT_MS,
});

const uvx = (args: string[], env?: Record<string, string>): McpEntry => ({
  command: 'uvx',
  args,
  ...(env ? { env } : {}),
  timeout: STDIO_TIMEOUT_MS,
});

const remote = (url: string, headers?: Record<string, string>): McpEntry => ({
  type: 'http',
  url,
  ...(headers ? { headers } : {}),
});

const remoteOauth = (url: string): McpEntry => ({ type: 'http', url, auth: 'oauth' });

const MCP_REFERENCE = 'Model Context Protocol';
const MCP_SERVERS_REPO = 'https://github.com/modelcontextprotocol/servers/tree/main/src';

export const MARKETPLACE_PLUGINS: MarketplacePlugin[] = [
  // ---------- ผู้ช่วยพื้นฐาน ----------
  {
    id: 'context7',
    name: 'Context7',
    publisher: 'Upstash',
    section: 'essentials',
    icon: 'book-open',
    color: '#14b8a6',
    description: {
      th: 'เอกสารล่าสุดของไลบรารีและเฟรมเวิร์ก ลดโค้ดที่อ้าง API เก่า',
      en: 'Up-to-date docs for libraries and frameworks, so code stops citing old APIs.',
    },
    homepage: 'https://github.com/upstash/context7',
    install: { kind: 'mcp', server: remote('https://mcp.context7.com/mcp') },
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    publisher: 'Cognition',
    section: 'essentials',
    icon: 'library',
    color: '#6366f1',
    description: {
      th: 'ถามเรื่องโครงสร้างและการใช้งานของ repo สาธารณะบน GitHub',
      en: 'Ask how any public GitHub repository is structured and used.',
    },
    homepage: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
    install: { kind: 'mcp', server: remote('https://mcp.deepwiki.com/mcp') },
  },
  {
    id: 'memory',
    name: 'Memory',
    publisher: MCP_REFERENCE,
    section: 'essentials',
    icon: 'brain',
    color: '#ec4899',
    description: {
      th: 'ความจำระยะยาวแบบ knowledge graph ที่อยู่ข้ามแชท',
      en: 'Long-term knowledge graph memory that carries across chats.',
    },
    homepage: `${MCP_SERVERS_REPO}/memory`,
    install: {
      kind: 'mcp',
      // ค่าเริ่มต้นเก็บในโฟลเดอร์แพ็กเกจของ npx ซึ่งถูกล้างได้ — ย้ายมาไว้ใน home ไม่ให้ความจำหาย
      server: npx(['@modelcontextprotocol/server-memory@2.0.1'], { MEMORY_FILE_PATH: '${USERPROFILE}/.dex-memory.jsonl' }),
    },
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    publisher: MCP_REFERENCE,
    section: 'essentials',
    icon: 'list-tree',
    color: '#a855f7',
    description: {
      th: 'ให้ agent คิดเป็นขั้นตอนและย้อนแก้ความคิดได้ เหมาะกับงานซับซ้อน',
      en: 'Lets the agent think in revisable steps, for problems that need planning.',
    },
    homepage: `${MCP_SERVERS_REPO}/sequentialthinking`,
    install: { kind: 'mcp', server: npx(['@modelcontextprotocol/server-sequential-thinking@2.0.0']) },
  },
  {
    id: 'time',
    name: 'Time',
    publisher: MCP_REFERENCE,
    section: 'essentials',
    icon: 'clock',
    color: '#0ea5e9',
    description: {
      th: 'บอกเวลาปัจจุบันและแปลงเขตเวลา',
      en: 'Current time and time zone conversion.',
    },
    homepage: `${MCP_SERVERS_REPO}/time`,
    install: { kind: 'mcp', server: uvx(['mcp-server-time@2026.10.28']) },
  },
  {
    id: 'git',
    name: 'Git',
    publisher: MCP_REFERENCE,
    section: 'essentials',
    icon: 'git-branch',
    color: '#f97316',
    description: {
      th: 'อ่าน log และ diff ค้นประวัติ และจัดการ branch ใน repo บนเครื่อง',
      en: 'Read logs and diffs, search history and manage branches in local repos.',
    },
    homepage: `${MCP_SERVERS_REPO}/git`,
    install: { kind: 'mcp', server: uvx(['mcp-server-git@2026.10.28']) },
  },

  // ---------- เว็บและเบราว์เซอร์ ----------
  {
    id: 'chrome-devtools',
    name: 'Chrome DevTools',
    publisher: 'Google',
    section: 'web',
    icon: 'bug-play',
    color: '#4285f4',
    description: {
      th: 'สั่ง Chrome ดีบักหน้าเว็บ ดู network และวัดประสิทธิภาพ',
      en: 'Drive Chrome to debug pages, inspect the network and profile performance.',
    },
    note: { th: 'ต้องมี Google Chrome ในเครื่อง', en: 'Needs Google Chrome on this machine.' },
    homepage: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    install: { kind: 'mcp', server: npx(['chrome-devtools-mcp@1.12.0']) },
  },
  {
    id: 'playwright',
    name: 'Playwright',
    publisher: 'Microsoft',
    section: 'web',
    icon: 'theater',
    color: '#22c55e',
    description: {
      th: 'เปิดเบราว์เซอร์ คลิก และกรอกฟอร์มเพื่อทดสอบเว็บแอปตามขั้นตอนจริง',
      en: 'Open a browser, click and fill forms to test web apps end to end.',
    },
    homepage: 'https://github.com/microsoft/playwright-mcp',
    install: { kind: 'mcp', server: npx(['@playwright/mcp@0.0.83']) },
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    publisher: 'Brave',
    section: 'web',
    icon: 'search',
    color: '#fb542b',
    description: {
      th: 'ค้นเว็บ ข่าว และรูปภาพผ่าน Brave Search API',
      en: 'Search the web, news and images through the Brave Search API.',
    },
    homepage: 'https://github.com/brave/brave-search-mcp-server',
    secrets: [{ name: 'BRAVE_API_KEY', label: 'Brave Search API key', helpUrl: 'https://brave.com/search/api/' }],
    install: {
      kind: 'mcp',
      server: npx(['@brave/brave-search-mcp-server@2.1.4', '--transport', 'stdio'], secretEnv('BRAVE_API_KEY')),
    },
  },
  {
    id: 'tavily',
    name: 'Tavily',
    publisher: 'Tavily',
    section: 'web',
    icon: 'telescope',
    color: '#3b82f6',
    description: {
      th: 'ค้นเว็บแบบออกแบบมาให้ AI ได้ผลสรุปพร้อมแหล่งอ้างอิง',
      en: 'Web search built for AI, returning summaries with sources.',
    },
    homepage: 'https://github.com/tavily-ai/tavily-mcp',
    secrets: [{ name: 'TAVILY_API_KEY', label: 'Tavily API key', helpUrl: 'https://app.tavily.com/' }],
    install: { kind: 'mcp', server: npx(['tavily-mcp@0.2.22'], secretEnv('TAVILY_API_KEY')) },
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    publisher: 'Firecrawl',
    section: 'web',
    icon: 'globe',
    color: '#f97316',
    description: {
      th: 'ดึงเนื้อหาเว็บทั้งเว็บเป็น Markdown รวมถึงหน้าที่สร้างด้วย JavaScript',
      en: 'Crawl whole sites into Markdown, including JavaScript-rendered pages.',
    },
    homepage: 'https://github.com/firecrawl/firecrawl-mcp-server',
    secrets: [{ name: 'FIRECRAWL_API_KEY', label: 'Firecrawl API key', helpUrl: 'https://www.firecrawl.dev/app/api-keys' }],
    install: { kind: 'mcp', server: npx(['firecrawl-mcp@3.36.0'], secretEnv('FIRECRAWL_API_KEY')) },
  },

  // ---------- สร้างและดูแลระบบ ----------
  {
    id: 'github',
    name: 'GitHub',
    publisher: 'GitHub',
    section: 'build',
    icon: 'git-pull-request',
    color: '#8b5cf6',
    description: {
      th: 'อ่าน repo จัดการ issue และ pull request ดูสถานะ CI',
      en: 'Read repos, manage issues and pull requests, check CI status.',
    },
    homepage: 'https://github.com/github/github-mcp-server',
    secrets: [
      {
        name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        label: 'GitHub personal access token',
        helpUrl: 'https://github.com/settings/personal-access-tokens',
      },
    ],
    install: {
      kind: 'mcp',
      server: remote('https://api.githubcopilot.com/mcp/', { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' }),
    },
  },
  {
    id: 'firebase',
    name: 'Firebase',
    publisher: 'Google',
    section: 'build',
    icon: 'flame',
    color: '#ffa000',
    description: {
      th: 'จัดการโปรเจกต์ Firebase ทั้ง Auth, Firestore และ Hosting',
      en: 'Manage Firebase projects, including Auth, Firestore and Hosting.',
    },
    note: {
      th: 'ต้องล็อกอินก่อนด้วยคำสั่ง npx firebase-tools login',
      en: 'Sign in first with npx firebase-tools login.',
    },
    homepage: 'https://firebase.google.com/docs/cli/mcp-server',
    install: { kind: 'mcp', server: npx(['firebase-tools@15.34.2', 'mcp', '--dir', '.']) },
  },
  {
    id: 'supabase',
    name: 'Supabase',
    publisher: 'Supabase',
    section: 'build',
    icon: 'database',
    color: '#3ecf8e',
    description: {
      th: 'อ่าน schema และ query ฐานข้อมูล Supabase แบบอ่านอย่างเดียว',
      en: 'Read schemas and query your Supabase database in read-only mode.',
    },
    homepage: 'https://supabase.com/docs/guides/getting-started/mcp',
    legacySecrets: ['SUPABASE_ACCESS_TOKEN'],
    install: { kind: 'mcp', server: remoteOauth('https://mcp.supabase.com/mcp?read_only=true') },
  },
  {
    id: 'neon',
    name: 'Neon',
    publisher: 'Neon',
    section: 'build',
    icon: 'database',
    color: '#00e599',
    description: {
      th: 'จัดการโปรเจกต์ Neon สร้าง branch และ query ฐานข้อมูล Postgres',
      en: 'Manage Neon projects, create branches and query Postgres databases.',
    },
    note: {
      th: 'Neon แนะนำให้ใช้กับงานพัฒนาและทดสอบเท่านั้น อย่าเชื่อมกับฐานข้อมูล production',
      en: 'Neon recommends this for development and testing only. Do not connect it to production databases.',
    },
    homepage: 'https://neon.com/docs/ai/neon-mcp-server',
    install: { kind: 'mcp', server: remoteOauth('https://mcp.neon.tech/mcp') },
  },
  {
    id: 'sentry',
    name: 'Sentry',
    publisher: 'Sentry',
    section: 'build',
    icon: 'radar',
    color: '#a78bfa',
    description: {
      th: 'ดู error และ issue จาก Sentry เพื่อไล่หาสาเหตุในโค้ด',
      en: 'Pull errors and issues from Sentry to trace their cause in your code.',
    },
    note: {
      th: 'ใช้ได้กับ sentry.io ถ้าเป็น Sentry แบบ self-hosted ให้เพิ่ม @sentry/mcp-server เองในตั้งค่า',
      en: 'Works with sentry.io. For self-hosted Sentry, add @sentry/mcp-server yourself in Settings.',
    },
    homepage: 'https://docs.sentry.io/product/sentry-mcp/',
    legacySecrets: ['SENTRY_AUTH_TOKEN', 'SENTRY_ACCESS_TOKEN'],
    install: { kind: 'mcp', server: remoteOauth('https://mcp.sentry.dev/mcp') },
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    publisher: 'MongoDB',
    section: 'build',
    icon: 'leaf',
    color: '#10b981',
    description: {
      th: 'สำรวจ collection และ query ข้อมูล MongoDB แบบอ่านอย่างเดียว',
      en: 'Explore collections and query MongoDB data in read-only mode.',
    },
    homepage: 'https://github.com/mongodb-js/mongodb-mcp-server',
    secrets: [
      {
        name: 'MDB_MCP_CONNECTION_STRING',
        label: 'MongoDB connection string',
        helpUrl: 'https://www.mongodb.com/docs/manual/reference/connection-string/',
      },
    ],
    install: {
      kind: 'mcp',
      server: npx(['mongodb-mcp-server@3.2.2', '--readOnly'], secretEnv('MDB_MCP_CONNECTION_STRING')),
    },
  },
  {
    id: 'microsoft-learn',
    name: 'Microsoft Learn',
    publisher: 'Microsoft',
    section: 'build',
    icon: 'graduation-cap',
    color: '#0ea5e9',
    description: {
      th: 'ค้นเอกสารทางการของ Azure, .NET และ Windows พร้อมตัวอย่างโค้ด',
      en: 'Search official Azure, .NET and Windows docs with code samples.',
    },
    homepage: 'https://github.com/MicrosoftDocs/mcp',
    install: { kind: 'mcp', server: remote('https://learn.microsoft.com/api/mcp') },
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    publisher: 'Cloudflare',
    section: 'build',
    icon: 'cloud',
    color: '#f38020',
    description: {
      th: 'จัดการบัญชี Cloudflare ผ่าน API เช่น Workers, DNS และ R2 โดยเลือกสิทธิ์ได้ตอนล็อกอิน',
      en: 'Manage your Cloudflare account through its API, such as Workers, DNS and R2. You choose the permissions at sign-in.',
    },
    homepage: 'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/',
    install: { kind: 'mcp', server: remoteOauth('https://mcp.cloudflare.com/mcp') },
  },
  {
    id: 'cloudflare-docs',
    name: 'Cloudflare Docs',
    publisher: 'Cloudflare',
    section: 'build',
    icon: 'cloud',
    color: '#f6821f',
    description: {
      th: 'ค้นเอกสารของ Workers, R2, D1 และบริการอื่นของ Cloudflare',
      en: 'Search docs for Workers, R2, D1 and the rest of Cloudflare.',
    },
    homepage: 'https://github.com/cloudflare/mcp-server-cloudflare',
    install: { kind: 'mcp', server: remote('https://docs.mcp.cloudflare.com/mcp') },
  },
  {
    id: 'aws-knowledge',
    name: 'AWS Knowledge',
    publisher: 'Amazon Web Services',
    section: 'build',
    icon: 'server',
    color: '#ff9900',
    description: {
      th: 'ค้นเอกสารและแนวทางจาก AWS รวมถึงบริการในแต่ละ region',
      en: 'Search AWS docs and guidance, including what is available per region.',
    },
    homepage: 'https://github.com/awslabs/mcp',
    install: { kind: 'mcp', server: remote('https://knowledge-mcp.global.api.aws') },
  },

  // ---------- เอกสารและการทำงาน ----------
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    publisher: 'taylorwilsdon',
    community: true,
    section: 'work',
    icon: 'briefcase',
    color: '#4285f4',
    description: {
      th: 'อ่านและแก้ Docs, Sheets, Slides, Drive, Calendar และ Gmail',
      en: 'Read and edit Docs, Sheets, Slides, Drive, Calendar and Gmail.',
    },
    note: {
      th: 'ต้องสร้าง OAuth client ประเภท Desktop app ใน Google Cloud และล็อกอินผ่านเบราว์เซอร์ตอนใช้ครั้งแรก',
      en: 'Needs a Desktop app OAuth client from Google Cloud, plus a browser sign-in on first use.',
    },
    homepage: 'https://github.com/taylorwilsdon/google_workspace_mcp',
    secrets: [
      {
        name: 'GOOGLE_OAUTH_CLIENT_ID',
        label: 'Google OAuth client ID',
        helpUrl: 'https://console.cloud.google.com/apis/credentials',
      },
      {
        name: 'GOOGLE_OAUTH_CLIENT_SECRET',
        label: 'Google OAuth client secret',
        helpUrl: 'https://console.cloud.google.com/apis/credentials',
      },
    ],
    install: {
      kind: 'mcp',
      server: uvx(['workspace-mcp@2.2.1', '--tool-tier', 'core'], secretEnv('GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET')),
    },
  },
  {
    id: 'notion',
    name: 'Notion',
    publisher: 'Notion',
    section: 'work',
    icon: 'notebook-pen',
    color: '#94a3b8',
    description: {
      th: 'ค้น อ่าน และแก้หน้าและฐานข้อมูลใน workspace ของ Notion',
      en: 'Search, read and edit pages and databases in your Notion workspace.',
    },
    homepage: 'https://developers.notion.com/docs/mcp',
    legacySecrets: ['NOTION_TOKEN'],
    install: { kind: 'mcp', server: remoteOauth('https://mcp.notion.com/mcp') },
  },
  {
    id: 'linear',
    name: 'Linear',
    publisher: 'Linear',
    section: 'work',
    icon: 'list-checks',
    color: '#5e6ad2',
    description: {
      th: 'ค้นหา สร้าง และอัปเดต issue และโปรเจกต์ใน Linear',
      en: 'Find, create and update issues and projects in Linear.',
    },
    homepage: 'https://linear.app/docs/mcp',
    install: { kind: 'mcp', server: remoteOauth('https://mcp.linear.app/mcp') },
  },
  {
    id: 'figma',
    name: 'Figma',
    publisher: 'Framelink',
    community: true,
    section: 'work',
    icon: 'pen-tool',
    color: '#f24e1e',
    description: {
      th: 'อ่าน layout และสไตล์จากไฟล์ Figma เพื่อนำมาเขียนเป็นโค้ด',
      en: 'Read layouts and styles from Figma files to turn them into code.',
    },
    homepage: 'https://github.com/GLips/Figma-Context-MCP',
    secrets: [
      {
        name: 'FIGMA_API_KEY',
        label: 'Figma personal access token',
        helpUrl: 'https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens',
      },
    ],
    install: { kind: 'mcp', server: npx(['figma-developer-mcp@0.13.2', '--stdio'], secretEnv('FIGMA_API_KEY')) },
  },

  // ---------- เกมและ 3D ----------
  {
    id: 'blender',
    name: 'Blender',
    publisher: 'MCP for Blender',
    community: true,
    section: 'creative',
    icon: 'box',
    color: '#ea7600',
    description: {
      th: 'สร้างและแก้ฉาก 3D ใน Blender ที่เปิดอยู่ด้วยการสั่งงานในแชท',
      en: 'Create and edit 3D scenes in your open Blender from the chat.',
    },
    note: {
      th: 'ต้องติดตั้ง add-on ก่อนด้วย uvx mcp-for-blender@2.2.6 install-addon และเปิด Blender ไว้',
      en: 'Install the add-on first with uvx mcp-for-blender@2.2.6 install-addon, then keep Blender open.',
    },
    homepage: 'https://github.com/ahujasid/mcp-for-blender',
    install: { kind: 'mcp', server: uvx(['mcp-for-blender@2.2.6']) },
  },
  {
    id: 'godot',
    name: 'Godot',
    publisher: 'Coding-Solo',
    community: true,
    section: 'creative',
    icon: 'gamepad',
    color: '#478cbf',
    description: {
      th: 'เปิด editor รันเกม สร้างฉาก และอ่าน debug output ของ Godot',
      en: 'Launch the editor, run the game, build scenes and read Godot debug output.',
    },
    note: {
      th: 'ต้องมี Godot ในเครื่อง ถ้าหาไม่เจอให้ตั้ง environment variable GODOT_PATH',
      en: 'Needs Godot on this machine. Set the GODOT_PATH environment variable if it is not found.',
    },
    homepage: 'https://github.com/Coding-Solo/godot-mcp',
    install: { kind: 'mcp', server: npx(['@coding-solo/godot-mcp@0.1.1']) },
  },

  // ---------- ชุด Skill ----------
  {
    id: 'code-review',
    name: 'Code Review',
    publisher: 'Dex',
    section: 'skills',
    icon: 'search-check',
    color: '#14b8a6',
    description: {
      th: 'รีวิว diff หา bug จริงพร้อมตัวอย่างที่ทำให้พัง เรียงตามความรุนแรง',
      en: 'Review a diff for real bugs, each with a trigger, worst first.',
    },
    homepage: 'https://agentskills.io',
    install: {
      kind: 'skill',
      skillName: 'code-review',
      summary: 'Review a code change for real bugs and report each with a concrete trigger. Use when asked to review a diff, commit, branch or pull request.',
      instructions: CODE_REVIEW_SKILL,
    },
  },
  {
    id: 'commit-message',
    name: 'Commit Message',
    publisher: 'Dex',
    section: 'skills',
    icon: 'git-commit',
    color: '#f97316',
    description: {
      th: 'เขียนข้อความ commit จาก diff ตามสไตล์ของโปรเจกต์',
      en: 'Write commit messages from the diff in the style of the project.',
    },
    homepage: 'https://agentskills.io',
    install: {
      kind: 'skill',
      skillName: 'commit-message',
      summary: 'Write a commit message from the staged diff, matching the project style. Use when asked to write or suggest a commit message.',
      instructions: COMMIT_MESSAGE_SKILL,
    },
  },
  {
    id: 'test-writer',
    name: 'Test Writer',
    publisher: 'Dex',
    section: 'skills',
    icon: 'flask',
    color: '#22c55e',
    description: {
      th: 'เขียนเทสต์ตาม framework ที่โปรเจกต์ใช้อยู่ แล้วรันให้เห็นผล',
      en: 'Write tests in the framework the project already uses, then run them.',
    },
    homepage: 'https://agentskills.io',
    install: {
      kind: 'skill',
      skillName: 'test-writer',
      summary: 'Add tests that pin down behaviour, following the existing test setup. Use when asked to write tests or improve coverage.',
      instructions: TEST_WRITER_SKILL,
    },
  },
  {
    id: 'debug-playbook',
    name: 'Debug Playbook',
    publisher: 'Dex',
    section: 'skills',
    icon: 'bug',
    color: '#ef4444',
    description: {
      th: 'ไล่หาสาเหตุทีละขั้นก่อนแก้โค้ด และยืนยันว่าหายจริง',
      en: 'Trace the root cause step by step before changing code, then verify the fix.',
    },
    homepage: 'https://agentskills.io',
    install: {
      kind: 'skill',
      skillName: 'debug-playbook',
      summary: 'Find the root cause of a bug through reproduction and focused checks before fixing it. Use when something fails or behaves unexpectedly.',
      instructions: DEBUG_PLAYBOOK_SKILL,
    },
  },
  {
    id: 'explain-code',
    name: 'Explain Code',
    publisher: 'Dex',
    section: 'skills',
    icon: 'message-question',
    color: '#a855f7',
    description: {
      th: 'อธิบายโค้ดตามลำดับการทำงานจริง ให้เข้าใจพอจะแก้เองได้',
      en: 'Explain code in execution order, well enough to change it yourself.',
    },
    homepage: 'https://agentskills.io',
    install: {
      kind: 'skill',
      skillName: 'explain-code',
      summary: 'Explain how code works in execution order so the user can change it. Use when asked to explain, walk through or teach a piece of code.',
      instructions: EXPLAIN_CODE_SKILL,
    },
  },
  {
    id: 'docs-writer',
    name: 'Docs Writer',
    publisher: 'Dex',
    section: 'skills',
    icon: 'file-text',
    color: '#3b82f6',
    description: {
      th: 'เขียน README และเอกสารจากสิ่งที่โค้ดทำจริง ไม่เดาเอง',
      en: 'Write READMEs and docs from what the code actually does, with no guessing.',
    },
    homepage: 'https://agentskills.io',
    install: {
      kind: 'skill',
      skillName: 'docs-writer',
      summary: 'Write or update documentation based on what the code does now. Use when asked to write a README, guide or other project docs.',
      instructions: DOCS_WRITER_SKILL,
    },
  },
];
