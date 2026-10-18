# รายงานตรวจสอบโค้ด (Code Review Report)

**โปรเจกต์:** Dex Agent (โฟลเดอร์ `D:\Pokemon_cli`)
**สถาปัตยกรรม:** Tauri v2 (Rust) + React 19 + TypeScript 6 + Vite 8
**วันที่ตรวจ:** 2026-10-11
**ขอบเขต:** ตรวจอ่านโค้ดทุกไฟล์ใน `src/`, `src-tauri/src/`, ไฟล์ config และรัน toolchain จริง
**สถานะ:** รายงานเท่านั้น — **ยังไม่ได้แก้ไขซอร์สโค้ดใด ๆ**

---

## 0. บทคัดย่อ (Executive Summary)

โปรเจกต์ **คอมไพล์ผ่านทั้งหมด** และโครงสร้างโดยรวมถือว่าดีสำหรับแอปขนาดนี้ (แยก hook/service/component ชัดเจน, มี human-in-the-loop approval, มี workspace sandbox ฝั่ง Rust)

แต่พบปัญหาที่กระทบ "ความถูกต้องของ Agent" และ "ความปลอดภัย" อยู่หลายจุดที่ต้องแก้ก่อนใช้งานจริง โดยเฉพาะ:

1. **Workspace sandbox ฝั่ง Rust ถูก bypass ได้** ด้วย path prefix ที่ไม่เช็ค separator → เขียนไฟล์นอก workspace ได้ (`D:\Pokemon_cli_evil`)
2. **Claude + Reasoning (extended thinking) จะได้ HTTP 400 ทันทีเมื่อ Agent เรียก tool มากกว่า 1 รอบ** เพราะไม่ส่ง `thinking` block กลับในประวัติ
3. **ประวัติ tool_use / tool_result ของ Claude และ Gemini หายทั้งหมดเมื่อขึ้นเทิร์นใหม่** → Agent "จำไม่ได้" ว่าเพิ่งอ่าน/เขียนไฟล์อะไรไป
4. **Gemini: ฟีเจอร์ "Thinking Process" ไม่มีทางทำงาน** เพราะไม่ได้ตั้ง `thinkingConfig.includeThoughts = true`
5. **ประวัติ OpenAI-compatible มีสตริง `"null"` ปนเข้าไปใน prompt** ทุกครั้งหลังจบรอบที่มีการเรียก tool
6. **กฎความปลอดภัย `check_security` ถูก bypass ได้ง่าย** และโหมด Auto-Pilot (ค่าเริ่มต้น = เปิด) auto-approve `git branch -D`, `cargo check` (รัน build script = code execution) ฯลฯ

นอกจากนี้มีประเด็นประสิทธิภาพ (เขียน localStorage ทั้งก้อนทุก ~40ms ระหว่าง stream), บั๊ก UX (กด Stop แล้วขึ้น error แทนคำว่า "ยกเลิก"), อัลกอริทึมที่เลือกไม่เหมาะ (grep/find เขียนเองแบบ O(N) ทั้งทรีแบบ synchronous บน main thread, DiffViewer ไม่ใช่ diff จริง) และไม่มี test/lint/CI เลย

### สรุปจำนวนประเด็น

| ระดับ | จำนวน | ตัวอย่าง |
|---|---|---|
| 🔴 วิกฤต (Critical) | 8 | Sandbox bypass, Claude thinking 400, context หาย, CSP บล็อก Custom provider, `"null"` ใน prompt |
| 🟠 สูง (High) | 9 | check_security bypass, prune ทำ tool pairing พัง, localStorage thrash, cancel→error |
| 🟡 กลาง (Medium) | 16 | token accounting ไม่ตรงกัน, race ต่าง ๆ, grep ไม่เป็น regex ตามที่โฆษณา, ไม่มี atomic write |
| ⚪ ต่ำ (Low / เก็บงาน) | 14 | i18n ไม่ครบ, a11y แทบไม่มี, DiffViewer ไม่ใช่ diff, ความสะอาดของโค้ด |

---

## 1. วิธีการตรวจและหลักฐานที่รันจริง

### 1.1 สิ่งที่ตรวจ
- `src/` ทั้งหมด: `App.tsx`, `components/*` (9 ไฟล์), `hooks/*` (4 ไฟล์), `services/*` (2 ไฟล์), `types/agent.ts`, `utils/i18n.ts`, `App.css`
- `src-tauri/src/lib.rs` (754 บรรทัด — หัวใจของ backend), `main.rs`, `Cargo.toml`, `tauri.conf.json`, `capabilities/default.json`, `build.rs`
- config: `package.json`, `tsconfig*.json`, `vite.config.ts`, `index.html`, `.gitignore`, `.env` (ตรวจเฉพาะชื่อตัวแปร ไม่ได้อ่านค่า)

### 1.2 ผลการรัน toolchain จริง

| คำสั่ง | ผล |
|---|---|
| `npx tsc --noEmit` (TypeScript 6.0.3) | ✅ ผ่าน ไม่มี error (ทั้งที่เปิด `strict`, `noUnusedLocals`, `noUnusedParameters`) |
| `vite build` (v8.2.2) | ✅ ผ่าน — 2122 modules, bundle 828 kB (207 kB gzip) + **คำเตือน chunk > 500 kB** |
| `cargo check --manifest-path src-tauri/Cargo.toml` | ✅ ผ่าน ไม่มี error/warning (cargo 1.96.0) |
| `git status` | ⚠️ **ไม่ใช่ git repository** (`fatal: not a git repository`) |

> **หมายเหตุความโปร่งใส:** การตรวจนี้จำเป็นต้องใช้ sandbox แบบ `danger-full-access` เพราะโหมด `workspace-write` ตั้ง ACL บน `D:\Pokemon_cli` ไม่สำเร็จ (`SetNamedSecurityInfoW failed (Win32 5): grantWrite`) ทำให้รันคำสั่งใด ๆ ไม่ได้เลย
> การรัน `vite build` และ `cargo check` **สร้าง/อัปเดตไฟล์ build artifact** (`dist/`, `src-tauri/target/`) เท่านั้น — **ไม่มีการแก้ไขไฟล์ซอร์สโค้ดแม้แต่ไฟล์เดียว**

### 1.3 ข้อมูลประกอบที่ดึงจาก dependency จริง
- `node_modules/@google/genai` v2.21.0 → `ThinkingConfig` มี field `includeThoughts?: boolean` (ยืนยันว่าไม่ได้ตั้งค่านี้)
- `node_modules/react-markdown` v10.1.0 → type ของ `code` component **ไม่มี prop `inline` แล้ว**
- `lucide-react` 1.44.0, `react-markdown` 10.1.0 ตรงกับ `package.json` ✅
- ตรวจภายนอก: โมเดล `gemini-3.8-flash`, `deepseek-v4` มีอยู่จริงในเอกสารผู้ให้บริการ (ไม่ได้เป็นชื่อสมมติ) และมีเคสจริงเรื่อง ["Extended thinking blocks not preserved during tool use loops causing 400"](https://github.com/anthropics/claude-code/issues/14264)

---

## 2. 🔴 ประเด็นวิกฤต (Critical)

### C-01 — Workspace Sandbox ถูก bypass ด้วย path prefix
**ไฟล์:** `src-tauri/src/lib.rs:90-99`

```rust
let ws_clean     = ...to_lowercase();
let target_clean = ...to_lowercase();
if !target_clean.starts_with(&ws_clean) { return Err(...); }
```

**ปัญหา:** เป็นการเทียบ "string prefix" ไม่ใช่ "path prefix" ดังนั้น workspace `d:\pokemon_cli` จะยอมรับ `d:\pokemon_cli_backup\secret.txt`, `d:\pokemon_cli-evil\x` หรือ `d:\pokemon_cli2\...` ทั้งหมด เพราะขึ้นต้นด้วยสตริงเดียวกัน

**ผลกระทบ:** เครื่องมือ `write_file` / `replace_file_content` / `read_file` / `list_dir` ถูกออกแบบมาให้เป็นด่านกัน Agent เขียนนอก workspace — ด่านนี้รั่ว ทำให้ agent (หรือ prompt injection จากไฟล์ในโปรเจกต์) เขียนทับไฟล์ข้างนอกได้

**แนวทางแก้ (ยังไม่แก้):** canonicalize แล้วเทียบแบบ path component (`ws.join(rel)` แล้วเช็ค `target.starts_with(ws)` ด้วย `Path::starts_with` หรือเทียบ `OsStr` ระดับ component) + กัน symlink/junction ด้วยการ canonicalize ตัวสุดท้ายจริง ไม่ใช่แค่ ancestor

---

### C-02 — Claude + Reasoning: HTTP 400 ทันทีเมื่อเรียก tool เกิน 1 รอบ
**ไฟล์:** `src/services/multiProviderAgent.ts:1046-1063` (ประกอบกับ `921-953`)

เมื่อเปิด extended thinking โค้ดตั้ง `thinking.budget_tokens` และ parse `thinking_delta` เพื่อโชว์ UI แต่ตอนสร้าง `contentBlocks` ที่จะ push กลับเข้าประวัติ **เก็บเฉพาะ `text` + `tool_use` — ทิ้ง `thinking` block และ `signature` ทั้งหมด**:

```ts
const contentBlocks: any[] = [];
if (stepText) contentBlocks.push({ type: 'text', text: stepText });
for (const tc of toolCalls) contentBlocks.push({ type: 'tool_use', ... });
this.conversationHistory.push({ role: 'assistant', content: contentBlocks });
```

Anthropic บังคับว่าถ้าเปิด thinking และส่ง assistant turn กลับเข้าไปใหม่ (ซึ่งจำเป็นใน tool loop) **ต้องแนบ thinking block พร้อม signature กลับไปด้วย** ไม่งั้นจะได้ 400

**ผลกระทบ:** ผู้ใช้ที่ตั้ง Effort ≠ None กับโมเดลสาย thinking (เช่น `claude-3-7-sonnet`) จะพังทันทีที่ Agent ต้องเรียก tool รอบที่ 2 → ฟีเจอร์หลักใช้งานไม่ได้จริง
**แนวทางแก้:** เก็บ `content_block_start`/`signature_delta` ระหว่าง stream แล้ว echo กลับทั้ง block (รวม `redacted_thinking`)

---

### C-03 — ประวัติ tool_use / tool_result ของ Claude และ Gemini หายทุกเทิร์น
**ไฟล์:** `multiProviderAgent.ts:382-416` (`prepareAnthropicHistory`), `304-341` (`prepareGoogleHistory`)

```ts
} else if (Array.isArray(item.content)) {
  text = item.content.map((c: any) => c.text || '').filter(Boolean).join('\n');
}
...
if (text) { converted.push({ role, content: text }); }   // ← ถ้า text ว่าง = ทิ้งทั้งข้อความ
```

`tool_use` block มี `name`/`input` (ไม่มี `.text`), `tool_result` block มี `content`/`tool_use_id` (ไม่มี `.text`) → ทั้งคู่กลายเป็นสตริงว่าง → **ถูกทิ้งทั้งข้อความ** ทุกครั้งที่ขึ้นเทิร์นใหม่

**ผลกระทบ:** ภายในเทิร์นเดียวทำงานได้ แต่พอผู้ใช้พิมพ์ข้อความถัดไป Claude/Gemini จะไม่เห็นร่องรอยว่าก่อนหน้านี้เรียก tool อะไร อ่านไฟล์อะไร เขียนอะไร → Agent ทำงานซ้ำ, เขียนทับ, หรือถามซ้ำ (Gemini ได้ผลกระทบเดียวกันผ่าน `prepareGoogleHistory` ที่แปลง `parts` เป็นข้อความ)
**หมายเหตุ:** ตามด้วย C-05 — การสลับ provider กลางเซสชันยิ่งทำให้ประวัติต่างค่ายปนกันและถูกแปลงเป็นข้อความขยะ

---

### C-04 — Gemini: ฟีเจอร์ Thinking ไม่มีทางทำงาน + ใช้ field ผิดรุ่น
**ไฟล์:** `multiProviderAgent.ts:589-597` และ `620-631`

```ts
if (this.settings.reasoningEffort !== 'none') {
  config.thinkingConfig = { thinkingBudget: budget };   // ← ขาด includeThoughts
}
...
if ((part as any).thought) { callbacks.onThoughtChunk?.(...) }   // ← ไม่มีวันเข้า
```

จาก type จริงของ SDK ที่ติดตั้ง (`@google/genai` 2.21.0):
```ts
export declare interface ThinkingConfig {
  /** Indicates whether to include thoughts in the response. If true, thoughts are returned only if ... */
  includeThoughts?: boolean;
  thinkingBudget?: number;
  thinkingLevel?: ThinkingLevel;
}
```
ต้องตั้ง `includeThoughts: true` จึงจะมี part ที่ `thought = true` → **UI "กระบวนการคิด" และ callback `onThoughtChunk` เป็น dead feature**

นอกจากนี้ `thinkingBudget` เป็นกลไกของตระกูล 2.5 ขณะที่ Gemini 3.x ใช้ `thinkingLevel` (MINIMAL/LOW/MEDIUM/HIGH) — โมเดลใน catalog เป็น `gemini-3.1-pro-preview` / `gemini-3.8-flash` ทั้งคู่ **ควรทดสอบยิงจริงว่า API ยอมรับ `thinkingBudget` หรือไม่** (เสี่ยง 400/ถูกละเว้นเงียบ ๆ)

---

### C-05 — `JSON.stringify(null)` ทำ prompt สกปรกด้วยสตริง `"null"` (path หลัก OpenAI/DeepSeek)
**ไฟล์:** `multiProviderAgent.ts:360-362` (และรูปแบบเดียวกันที่ `316-324`, `397-399`)

```ts
} else if (item.content !== undefined) {
  content = JSON.stringify(item.content);
}
```

ข้อความ assistant ที่มีการเรียก tool จะถูกเก็บเป็น `{ role:'assistant', content: null, tool_calls:[...] }` (บรรทัด 848) ซึ่ง `content !== undefined` เป็น **true** → `JSON.stringify(null)` ได้สตริง `"null"`

**ผลกระทบ:** ตั้งแต่เทิร์นที่ 2 เป็นต้นไป ประวัติที่ส่งให้ API จะมี assistant message ที่เนื้อหาคือคำว่า `"null"` ปนอยู่ทุกจุดที่เคยเรียก tool → สิ้นเปลือง token และรบกวนคุณภาพคำตอบ และประวัติจะ "สะสม" สตริงนี้ต่อไปเรื่อย ๆ
**แนวทางแก้:** เปลี่ยนเงื่อนไขเป็น `item.content != null` (หรือแยกเช็ค `typeof`)

---

### C-06 — CSP บล็อก Custom Provider ที่ไม่ใช่ localhost
**ไฟล์:** `src-tauri/tauri.conf.json:25`

`connect-src` ระบุ whitelist เป็นรายโฮสต์ของผู้ให้บริการ + `http://localhost:* http://127.0.0.1:*`
แต่โหมด `custom` ให้ผู้ใช้กรอก Base URL อะไรก็ได้ (เช่น vLLM/LMStudio ผ่าน LAN, Azure OpenAI, proxy องค์กร ที่เป็น `https://...`) → **ถูก CSP ตัดการเชื่อมต่อทันที**
**ผลกระทบ:** ฟีเจอร์ "Custom / Local (Ollama, LMStudio, VLLM)" ใช้ได้เฉพาะ localhost
**หมายเหตุเสริม:** `script-src 'self' 'unsafe-inline'` เป็นการลดความเข้มของ CSP ใน production (ไม่ควรมีถ้าไม่จำเป็น) — และเมื่อ API key ถูกเก็บใน localStorage ความเสี่ยง XSS จึงมีนัยสำคัญ

---

### C-07 — กด Stop แล้วขึ้น "ข้อผิดพลาด" แทน "ยกเลิก"
**ไฟล์:** `multiProviderAgent.ts:760-765, 955-965` + `useAgentChat.ts:257-266`

เพราะส่ง `signal: abortSignal` เข้า `fetch` ตรง ๆ เมื่อผู้ใช้กด Stop ตัว fetch จะ reject ด้วย `AbortError` (ข้อความ "This operation was aborted") **ไม่ใช่ข้อความไทย `'การทำงานถูกยกเลิก'`** ที่ส่งมาจากการเช็ค abort เอง
→ เงื่อนไข `err?.message?.includes('ยกเลิก')` ไม่เข้า → UI แสดง `🚨 ข้อผิดพลาด: ...` แทนข้อความยกเลิกที่สุภาพ
**แนวทางแก้:** เช็ค `err.name === 'AbortError' || abortController.signal.aborted` เป็นหลัก (ไม่พึ่งข้อความ)

---

### C-08 — `cwd` จาก environment ไม่มีทางถูกใช้ + hardcode path
**ไฟล์:** `src/hooks/useAppSettings.ts:61, 81-103` + `src/services/tauriBridge.ts:11` + `src/components/ChatHistorySidebar.tsx:44`

```ts
cwd: prev.cwd || env.cwd,   // ← prev.cwd ถูก hardcode เป็น 'd:/Pokemon_cli' ตั้งแต่ต้น → ไม่วันเป็น falsy
```
ค่าเริ่มต้นของ settings คือ `cwd: 'd:/Pokemon_cli'` และ fallback ของ bridge ก็ hardcode ค่าเดียวกัน
**ผลกระทบ:** ย้ายโปรเจกต์/รันจากเครื่องอื่น แอปจะชี้ไปโฟลเดอร์ที่ไม่มีอยู่ (และ `get_initial_env` อ่าน `.env` จาก process CWD ซึ่งอาจไม่ใช่โฟลเดอร์แอปด้วย) → รายการไฟล์ว่าง, tool ทุกตัว error, และผู้ใช้ต้องไปตั้งเองใหม่

---

## 3. 🟠 ประเด็นระดับสูง (High)

### H-01 — `check_security` ถูก bypass และ Auto-Pilot อนุมัติคำสั่งอันตรายอัตโนมัติ
**ไฟล์:** `src-tauri/src/lib.rs:143-191` + `multiProviderAgent.ts:1126`

จุดอ่อน 2 ชั้น:
1. **Deny-list เป็น substring** (`lib.rs:111-129`): `remove-item -recurse -force c:` ไม่ match `Remove-Item -Path C:\ -Recurse -Force`, `rmdir /s /q c:` ไม่ match `cmd /c rd /s /q C:\` → "hard block" ให้ความมั่นใจแบบผิด ๆ
2. **Allow-list อ่านอย่างเดียวอิง prefix ของชื่อคำสั่ง ไม่ได้ parse subcommand/flag** → ในโหมด Auto-Pilot (ค่าเริ่มต้น `autoPilot: true` ที่ `useAppSettings.ts:60`) คำสั่งเหล่านี้จะ **รันอัตโนมัติโดยไม่ถาม**:
   - `git branch -D main` (ลบ branch = data loss)
   - `git diff --output=C:\...\x` (เขียนไฟล์)
   - `cargo check` (รัน build script = **code execution**)
   - `type`/`cat`/`where` ใช้ได้ตามปกติ แต่ `get-content` ก็สามารถเปิดไฟล์นอก workspace ได้

นอกจากนี้ deny-list มี false positive: คำว่า `"shutdown"` ทำให้ `git log --grep=shutdown` ถูกบล็อก

**ข้อสังเกตเชิงออกแบบ:** การเช็คนี้เป็น "string matching" ทั้งหมด ไม่มีการแยก token/AST ของ PowerShell จึงไม่มีทางกันได้จริง — ทางที่เหมาะคือยอมรับว่า "policy = ต้องอนุมัติทุกคำสั่งที่เขียนได้" แล้วใช้การวิเคราะห์เชิงไวยากรณ์ หรือรันใน sandbox/container

---

### H-02 — `pruneConversationHistory` ตัดประวัติกลางคู่ tool_use/tool_result
**ไฟล์:** `multiProviderAgent.ts:175-190`

```ts
let cutIndex = Math.max(0, bodyMessages.length - maxMessages);
while (cutIndex < bodyMessages.length && bodyMessages[cutIndex]?.role !== 'user') cutIndex++;
```
- **OpenAI**: tool result เป็น `role:'tool'` → ตัดที่ `user` ปลอดภัย ✅
- **Anthropic**: tool result ถูก push เป็น `{ role:'user', content:[tool_result] }` (`1084`) → **ตัดที่ข้อความ user ที่เป็น tool_result ได้เลย** → เหลือ `tool_result` ที่ไม่มี `tool_use` นำหน้า → **HTTP 400 (`unexpected tool_use_id`)**
- **Gemini**: functionResponse ถูก push เป็น `{ role:'user', parts:[functionResponse] }` (`666`) → เหมือนกัน → `INVALID_ARGUMENT`

**ปัญหาเชิงอัลกอริทึม:** prune นับ "จำนวนข้อความ" ไม่ใช่ "จำนวน token" และไม่มีการตรวจความถูกต้องของคู่ (pair integrity) — tool result 1 ก้อนที่ใหญ่ 200 kB ไม่ถูก prune เลย ขณะที่ข้อความสั้น ๆ 18 ข้อความถูกตัดทิ้ง

---

### H-03 — เขียน localStorage ทั้งก้อนทุก ~40ms ระหว่างสตรีม
**ไฟล์:** `src/hooks/useChatSessions.ts:126-132` (effect `[sessions]`) + `135-171` (effect `[messages, ...]`) + `useAgentChat.ts:147-182`

ทุกครั้งที่ flush ข้อความ (throttle 40ms) → `setMessages` → effect 6 → `setSessions` → effect 5 → `JSON.stringify(sessions)` **ทั้งก้อนทุกเซสชัน (รวมข้อความทั้งหมด)** แล้วเขียนลง localStorage
**ผลกระทบ:** ประวัติยาว ๆ (หลาย MB) จะทำให้ UI กระตุกอย่างหนัก, กิน CPU/IO ซ้ำซ้อน และสุดท้ายชน quota → `catch` กลืน error → **ประวัติหยุดถูกบันทึกแบบเงียบ ๆ**
**แนวทางแก้:** debounce การ persist, แยกเก็บเป็นราย session, หรือย้ายการเก็บประวัติไปฝั่ง Rust (SQLite/ไฟล์)

---

### H-04 — Race: กดส่งซ้ำ / `isRunning` ล้า 1 เรนเดอร์
**ไฟล์:** `src/hooks/useAgentChat.ts:83` + `src/App.tsx:92-93`

```ts
if (!prompt || isRunning) return;   // isRunning มาจาก state ที่อาจยังไม่อัปเดตในติ๊กเดียวกัน
```
คลิกเร็ว ๆ 2 ครั้ง (หรือ Enter + การ์ด quick prompt) ใน tick เดียวกันจะผ่านทั้งคู่ → เรียก API ซ้อน 2 ชุด ใช้ token ซ้ำ และข้อความสลับกัน
และ `isRunningRef.current = isRunning;` ใน render body (`App.tsx:92`) เป็น side effect ระหว่าง render ทำให้ `useChatSessions` ได้ค่าล้าไป 1 เรนเดอร์

---

### H-05 — Tool schema ถูกเขียนซ้ำ 2 ชุด และเริ่ม drift
**ไฟล์:** `multiProviderAgent.ts:22-140` (`AGENT_TOOLS_DEFINITIONS`) เทียบกับ `448-566` (inline `toolsConfig` ของ Gemini)

รายการ tool 7 ตัวถูกก๊อปวางซ้ำสำหรับ Gemini โดย**ตัด `max_results` ของ `grep_search` ออก** และคำอธิบายไม่ตรงกัน (`"เขียนทับเนื้อหาไฟล์"` vs `"สร้างหรือบันทึก"`)
**ผลกระทบ:** เพิ่ม/แก้ tool ต้องแก้ 2 ที่ → drift ต่อไปแน่นอน (maintainability)

---

### H-06 — ลิงก์ใน Markdown ทำให้แอปทิ้งหน้าจอ
**ไฟล์:** `src/components/ChatMessageItem.tsx:106-141`

`ReactMarkdown` override เฉพาะ `code` — ไม่ได้จัดการ `a` เลย เมื่อคำตอบของ AI มีลิงก์ ผู้ใช้คลิก = **เว็บวิวนำทางออกจาก UI ของแอป** (ไม่มี `target="_blank"`, ไม่มี `preventDefault`, และโปรเจกต์มี `@tauri-apps/plugin-opener` แต่ไม่เคยเรียกใช้)

พร้อมกันนี้ พบว่า `inline` ไม่มีอยู่ใน prop ของ react-markdown v10 แล้ว (ยืนยันจาก type ที่ติดตั้ง) ทำให้ `!inline` เป็น `true` เสมอ → โค้ดบล็อกที่ **ไม่ระบุภาษา** จะถูกเรนเดอร์เป็น inline code (ซ้อน `<pre><code class="inline-code">`)

---

### H-07 — `kill_command` รั่วหน่วยความจำ + มี race ทำให้ยกเลิกไม่ทำงาน
**ไฟล์:** `src-tauri/src/lib.rs:240-274, 370-387`

- `cancelled_ids.insert(id)` แล้วลบทิ้งเฉพาะเมื่อมี `execute_command` ที่ id ตรงกัน **ภายหลัง** → ถ้า kill หลัง process จบแล้ว entry จะค้างตลอดอายุโปรแกรม (โตขึ้นเรื่อย ๆ ตามจำนวนครั้งที่กด Stop)
- **Race:** ระหว่าง post-check (`253-256`) กับตอน insert เข้า `running_processes` (`271-274`) ถ้า kill เข้ามาพอดี จะ insert cancelled ไว้แต่ไม่มี process ให้ kill → **คำสั่งนั้นรันต่อไปโดยยกเลิกไม่ได้**
- ใช้ `taskkill /F /T /PID` จาก PID ที่อาจถูก reuse → เสี่ยงฆ่า process อื่น (โอกาสต่ำแต่มีจริง)

---

### H-08 — `grep_search` / `find_files` เป็น synchronous ทั้งทรีบน main thread
**ไฟล์:** `src-tauri/src/lib.rs:530-592, 596-654`

`#[tauri::command] fn` (ไม่ใช่ async) ที่เดินทั้ง directory tree และ `fs::read_to_string` ทุกไฟล์ → **บล็อก main thread ของ Tauri → หน้าต่างค้าง** (โปรเจกต์นี้มี `node_modules` + `src-tauri/target` หลายพันไฟล์)
จุดอื่น:
- ไม่มี `validate_workspace_path` (ต่างจาก tool ไฟล์ตัวอื่น) → ถ้า workspace ถูกตั้งเป็น `C:\` จะสแกนทั้งดรัฟ
- **ไม่มีกัน symlink/junction cycle** → `dirs_to_visit` อาจวนไม่จบ (path.is_dir() ตาม symlink)
- ข้ามไฟล์ที่ขึ้นต้นด้วย `.` ทั้งหมด → มองไม่เห็น `.env`, `.gitignore`, `.github/**` (ทั้งที่ tool นี้ควรใช้ตรวจโปรเจกต์)
- ไม่มีเพดานขนาดไฟล์/ไบนารี → อ่านไฟล์ 100 MB เข้าหน่วยความจำ
- ผลลัพธ์ถูกตัดที่ 50/100 แบบเงียบ ๆ และลำดับไม่แน่นอน (`pop()` + `read_dir` order)

---

### H-09 — ไม่มี atomic write / จัดการ encoding ไม่ครบ
**ไฟล์:** `src-tauri/src/lib.rs:397-407, 459-519`

- `fs::write` ทับไฟล์ตรง ๆ → ถ้าแอป/เครื่องดับกลางคัน ไฟล์เสียหายทั้งไฟล์ (ควรเขียน temp แล้ว rename)
- `fs::read_to_string` ใช้ได้เฉพาะ UTF-8 → ไฟล์ UTF-16 (พบบ่อยบน Windows) หรือไฟล์ที่มี BOM จะได้ error/ไม่ match target
- โหมด fallback CRLF: `new_text.replace('\n', "\r\n")` แปลง **ทุก** LF เป็น CRLF (ไฟล์ที่ผสมบรรทัดจะเพี้ยน) และ path ปกติ (`count == 1`) กลับไม่ปรับ line ending ของ `replacement_content` เลย
- `occurrences` ใน `ReplaceResult` มีค่าเป็น 1 เสมอ → field นี้ไม่มีประโยชน์

---

## 4. 🟡 ประเด็นระดับกลาง (Medium)

| # | ประเด็น | ไฟล์อ้างอิง | รายละเอียด |
|---|---|---|---|
| M-01 | สลับ provider แล้วได้โมเดลแรกของลิสต์ ไม่ใช่ตัว `isDefault` | `Header.tsx:39-46`, `SettingsModal.tsx:244-252` | Google → เลือก `gemini-3.1-pro-preview` (แพง) แทน `gemini-3.8-flash` ทั้งที่ catalog ระบุ `isDefault` ไว้ |
| M-02 | สลับ provider แล้วไม่รีเซ็ต/แปลงประวัติให้ตรงฟอร์แมต | `multiProviderAgent.ts:213-229` | สลับ OpenAI→Gemini กลางเซสชัน ประวัติ assistant ที่ `content:null` + `tool_calls` จะถูกแปลงเป็นข้อความ `"null"` และ tool_calls หาย |
| M-03 | Token accounting ไม่สอดคล้องกัน 3 ไดรเวอร์ | `613-618` (assignment), `806-808` (assignment), `1003-1011` (`+=`) | Anthropic บวกสะสมทุกรอบ (นับ prompt ซ้ำเพราะ prompt รอบหลังมี context เดิมอยู่แล้ว) ขณะที่เจ้านอื่นใช้ค่าล่าสุด → ตัวเลข session token ต่างกันคนละหลัก |
| M-04 | ข้อความเตือน "ถึงขีดจำกัด 8 ขั้นตอน" ขึ้นผิดจังหวะ | `669-674`, `885-890`, `1087-1092` | ถ้าโมเดลตอบจบพอดีในขั้นที่ 8 (`break` เพราะไม่มี tool call) `step >= 8` ยังจริง → ขึ้นเตือนทั้งที่งานเสร็จสมบูรณ์ |
| M-05 | Approvals map รั่ว + ไม่มี timeout | `useAgentChat.ts:224-232` | `onAbort` resolve(false) แต่ไม่ `delete(tool.id)` จาก map → entry ค้าง; และถ้าผู้ใช้ไม่กดอะไรเลย promise จะค้างตลอด (ไม่มี timeout/auto-reject) |
| M-06 | `/clear`, `/help` ถูกบล็อกถ้าไม่มี API key | `useAgentChat.ts:85-97` | เช็ค key ก่อนจัดการ slash command → อยากล้างแชทแต่ดันเปิดหน้าตั้งค่า |
| M-07 | IME composition ส่งข้อความกลางคัน | `App.tsx:254-259` | ไม่เช็ค `e.nativeEvent.isComposing` — ผู้ใช้พิมพ์ไทย/จีน/ญี่ปุ่นกด Enter เพื่อเลือกคำCandidate จะ "ส่ง" ทันที |
| M-08 | ไม่มีข้อจำกัดขนาด/เวลาในการอนุมาน tool result | `multiProviderAgent.ts:265-288` | ตัดที่ 10,000 ตัวอักษรต่อผลลัพธ์ แต่ค่าเก่าที่เก็บในประวัติแล้วไม่ถูกตัดตาม และไม่มีเพดานต่อรอบ (7 tools × 10k) |
| M-09 | SSE parser ทิ้งข้อมูลท้ายสตรีม | `783-846`, `981-1044` | `buffer` ส่วนที่เหลือหลัง `done` ไม่ถูก parse (usage chunk สุดท้ายหายได้) และ `if (dataStr === '[DONE]') break;` ออกจากแค่ลูป in ไม่ได้หยุด reader |
| M-10 | Tool args ไม่ถูก validate/coerce | `1099-1260` | `max_results`/`case_insensitive` ที่โมเดลส่งมาเป็น string จะทำให้ serde ฝั่ง Rust error ทั้งคำสั่ง (ควร `Number()`/`Boolean()` + default) |
| M-11 | ไม่มี error boundary | `main.tsx`, `App.tsx` | render error ครั้งเดียว = จอขาวทั้งแอป |
| M-12 | API key ถูกเก็บ plaintext ใน localStorage และส่งผ่าน webview | `useAppSettings.ts:106-113` | `.env` ถูกอ่านเข้า settings แล้ว persist ลง `dex_agent_settings_v2`; ร่วมกับ CSP `unsafe-inline` และไม่มี error boundary → ความเสี่ยง XSS ที่มีนัย |
| M-13 | Shell command ไม่ถูกจำกัดขอบเขต workspace | `lib.rs:218-366` | sandbox มีผลเฉพาะ tool ไฟล์ — คำสั่ง PowerShell ที่ได้รับอนุมัติอ่าน/เขียนได้ทั้งเครื่อง (ควรระบุใน UI ให้ชัด) |
| M-14 | Auto-Pilot กับ tooltip ไม่ตรงกัน | `multiProviderAgent.ts:1162-1211`, `i18n.ts:110` | tooltip บอก "จะถามยืนยันเฉพาะคำสั่งลบหรือแก้ไขไฟล์สำคัญ" แต่ใน Auto-Pilot `write_file`/`replace_file_content` **ไม่ถามเลย** |
| M-15 | TerminalDrawer รวม log ทุกคำสั่ง + `key={index}` | `TerminalDrawer.tsx:113-117` | ไม่กรองตาม `activeCommandId`, ลบ/ตัด log แล้ว React reuse แถวผิด, และ `useEffect` scroll ด้วย `smooth` ทุก event ระหว่างสตรีม |
| M-16 | ตัวเลข token ที่ประเมินเองคลาดเคลื่อนสูง | `multiProviderAgent.ts:232-240` | `length / 3.8` ใช้กับภาษาไทยไม่ได้ (ตัวอักษรไทย/อังกฤษผสมกันคนละอัตรา) และคิดจาก userInput + คำตอบล่าสุดเท่านั้น ไม่รวมประวัติ/tool result |

---

## 5. ⚪ ประเด็นระดับต่ำ / งานเก็บรายละเอียด (Low)

1. **`DiffViewer` ไม่ใช่ diff จริง** (`DiffViewer.tsx:22-47`) — แสดง "ทุกบรรทัดเดิมเป็นลบ" แล้วต่อด้วย "ทุกบรรทัดใหม่เป็นบวก" ไม่มี LCS/Myers; ตัวเลข +/- คือจำนวนบรรทัดรวม ซึ่งทำให้เข้าใจผิด และ comment ในโค้ดเขียนว่า `// Simple unified diff computation` ทั้งที่ไม่ได้คำนวณ diff
2. **วง token วนซ้ำทุก 50,000 token** (`CircularTokenMeter.tsx:44-46`) — `sessionTokens % threshold` ทำให้ใช้ไป 50,001 token แล้ววงกลับไปเริ่มใหม่ = สื่อสารผิด
3. **`useResizablePanel`** (`:18-31, 48-55`) — `parseInt` ค่าเพี้ยนใน localStorage → `Math.max(170, Math.min(550, NaN))` = `NaN` → layout พัง; และถ้าปล่อยเมาส์นอกหน้าต่าง `mouseup` ไม่ทำงาน → ค้างในโหมดลาก
4. **Clipboard copy** (`ChatMessageItem.tsx:44-48`) — `isCopied` เป็น state เดียวใช้ร่วมทุก code block (กดอันหนึ่ง ขึ้น "คัดลอกแล้ว" ทุกอัน) และไม่ `.catch()` promise
5. **i18n ไม่ครบ** — ชื่อ tool ใน UI เป็นอังกฤษตายตัว (`'Read File'`, `'PowerShell'` ฯลฯ), มีข้อความไทยฝังในโค้ด (`'แก้ไขโค้ด: '`, `'รวมรอบล่าสุด:'`), `FileExplorer.tsx:122` ใส่ prompt ภาษาไทยเสมอแม้ตั้งค่าเป็น English, tool description ฝั่ง service เป็นไทยตายตัว
6. **i18n hint อ้างโมเดลที่ไม่มีใน catalog** — `i18n.ts:107,218` กล่าวถึง "Claude Fable 5.1", "GPT-6", "Grok 4.6", "DeepSeek V4 Pro" ซึ่งไม่ตรงกับ `PROVIDERS_CATALOG`
7. **Accessibility แทบไม่มี** — grep ทั้ง `src/` ไม่พบ `aria-*` / `role=` ในคอมโพเนนต์แม้แต่จุดเดียว (เจอเฉพาะในไฟล์ asset `src/assets/react.svg`); องค์ประกอบที่คลิกได้เป็น `<div onClick>` (`workspace-badge`, `tool-card-header`, `file-tree-item`, `history-session-item`) ไม่มี `tabIndex`/คีย์บอร์ด; มี `<button>` ซ้อนใน `<div onClick>` (`Header.tsx:63-74`); modal ไม่มี focus trap/ปิดด้วย Escape
8. **โค้ดตาย/ไม่ได้ใช้** — `getHistory()`, `onViewFile` (ส่งต่อแล้วเปลี่ยนชื่อ `_onViewFile`), `types/agent.ts` `ReplaceResult`/`GrepMatchItem`/`FileDiffData`, `ToolCallRecord.commandId`
9. **Dead code ที่พิสูจน์ได้** — `if (this.conversationHistory.length === 0)` ใน `sendOpenAICompatible:705-707` ไม่มีทางเป็นจริง เพราะ `prepareOpenAIHistory()` คืน system message เสมอ
10. **`prepareOpenAIHistory` สร้าง `tool_call_id` จาก `Date.now()`** (`:368`) — id ไม่คงที่ และ id ปลอมไม่ตรงกับที่ผู้ให้บริการออกให้
11. **Header ปุ่ม Clear ไม่มีการยืนยัน** — กดพลาด = ประวัติหายทันที (ทั้งที่การลบ session มี confirm 2 จังหวะ)
12. **โหลด `.env` ได้ไม่ครบทุกค่าย** (`lib.rs:677-689`) — รองรับแค่ google/anthropic/openai/deepseek/openrouter/groq; ขาด `XAI_API_KEY`, `DASHSCOPE_API_KEY`/`QWEN`, `MOONSHOT_API_KEY`, `SILICONFLOW_API_KEY`
13. **`customBaseUrl` ไม่ normalize** — ผู้ใช้กรอก `http://localhost:11434` (ไม่มี `/v1`) จะได้ path `/chat/completions` → 404; และถ้าไม่กรอก custom model จะ fallback ไป `custom-model` ที่ไม่มีจริง
14. **เอกสาร/ทรัพยากรไม่ตรงกับแอป** — `README.md` ยังเป็น template ของ Tauri, favicon ยังเป็นโลโก้ Vite, ชื่อ package `dex-agent` vs โฟลเดอร์ `Pokemon_cli`; ไม่มี `.git` (ยืนยันด้วย `git status`) → **ไม่สามารถ diff/ย้อนรอยการแก้ไฟล์ของ Agent ได้**

---

## 6. 🧮 วิเคราะห์อัลกอริทึม (Algorithm Review)

| จุด | ที่ใช้อยู่ | เหมาะสมหรือไม่ | ข้อเสนอเชิงออกแบบ |
|---|---|---|---|
| ค้นหาโค้ด `grep_search` | เดินทรีเอง + `read_to_string` + `String::contains` (sync) | ❌ ไม่เหมาะ | คำอธิบาย tool บอกว่า "รองรับ Regex เหมือน ripgrep" แต่ทำได้แค่ substring (โมเดลที่ส่ง `fn\s+\w+` จะได้ผลผิดแบบเงียบ ๆ) → ใช้ crate `ignore` (`WalkBuilder`) + `regex`/`grep-searcher` หรือเรียก `rg` เป็น sidecar, รันใน `spawn_blocking`/`async`, กัน symlink cycle, ข้ามไบนารี/ไฟล์ใหญ่ |
| ค้นหาไฟล์ `find_files` | เดินทรีเอง + `contains`/`ends_with` | ❌ ไม่เหมาะ | ไม่ใช่ glob จริง (`src/**/*.rs` ใช้ไม่ได้), เพดาน 100 แบบเงียบ, ลำดับไม่คงที่ → ใช้ `globset` หรือ `ignore` |
| ตัดประวัติ `pruneConversationHistory` | นับจำนวนข้อความ, ตัดที่ role `user` | ❌ ไม่เหมาะ | ต้องเป็น **token-budget** และต้องรักษาคู่ `tool_use`↔`tool_result` (ตัดได้เฉพาะขอบเขต turn ที่สมบูรณ์) ไม่งั้น 400 (ดู H-02) |
| Diff preview | ไล่บรรทัดเดิมทั้งหมดแล้วตามด้วยบรรทัดใหม่ทั้งหมด | ❌ | ใช้ LCS/Myers (`similar`, `diff` crate หรือ lib ฝั่ง JS) เพื่อให้เห็น context ที่ไม่เปลี่ยนด้วย |
| Streaming + throttle 40ms | ✅ ดีแล้ว | ✔ | แต่ควรใช้ `useReducer`/store เดียวต่อข้อความ ลด re-render ของ `ReactMarkdown` ทั้งก้อน (ยังไม่มี `React.memo` → parse markdown ใหม่ทุก flush ทุกข้อความ) |
| ประมาณ token | `length / 3.8` | ❌ | ใช้ค่าจากผู้ให้บริการ (มีอยู่แล้วบางค่าย) หรือ tokenizer จริง; ถ้าจำเป็นต้องประมาณ ให้แยกอัตราตัวอักษรไทย/ละติน และคิดจาก "ทั้ง prompt ที่ส่งจริง" |
| Terminal log buffer | `[...prev, payload]` แล้ว `slice(-500)` | △ | copy array 500 ชิ้นทุก event → ใช้ ring buffer/index หรือ `useRef` + batch |
| ตัด tool result | `slice(0, 10000)` ต่อผลลัพธ์ | △ | ควรมี budget รวมต่อรอบ + ตัดหัว/ท้ายให้เห็นบริบท (ตอนนี้ตัดท้ายทิ้งหมด ทำให้ error ท้ายไฟล์หาย) |
| ตัวนับความคืบหน้า token | `sessionTokens % 50000` | ❌ | ใช้สเกล log หรือวงหลายชั้น / แสดงเป็นตัวเลขจะสื่อกว่าวงวนรอบ |

---

## 7. 🧱 คุณภาพโค้ดและสถาปัตยกรรม

1. **`any` ครองชั้น agent** — grep เจอ 33 จุด และเกือบทั้งหมดอยู่ใน `multiProviderAgent.ts` (ประวัติ, chunk, request body, tool result) → type system ช่วยไม่ได้เลยในโค้ดส่วนที่ซับซ้อนและเสี่ยงที่สุด ควรมี type ของ "normalized message" กลาง (เช่น `NormalizedMessage { role; text; toolCalls; toolResults }`) แล้วให้แต่ละไดรเวอร์แปลงเข้า-ออกจากโมเดลกลางนี้ — จะแก้ C-03/C-05/M-02 ได้พร้อมกันในที่เดียว
2. **ไดรเวอร์ 3 ตัวมีโค้ดซ้ำมาก** — โครง `while (step < 8)` + สร้าง tool list + ข้อความเตือน + `compactToolResult` + note ท้าย ถูกก๊อป 3 ชุด (magic number 8 ซ้ำ 3 ที่) → แยกเป็น base/strategy
3. **ไม่มี abstraction ระหว่าง "tool registry" ฝั่ง TS กับคำสั่ง Rust** — ชื่อ tool, schema, และการ map args ไปยัง `invoke` กระจายอยู่ใน `executeToolWithGuard` (ยาว ~160 บรรทัด, if/else 8 ทาง) → ควรทำ map `Record<ToolName, Handler>` เพื่อลดความยาวและเพิ่ม testability
4. **ผลข้างเคียงระหว่าง render** — `App.tsx:92-96` เซ็ต ref ระหว่าง render (ผิดหลัก React, อาจเพี้ยนกับ concurrent rendering)
5. **ข้อความ error/สถานะผูกกับภาษาไทย** — ใช้ `err.message.includes('ยกเลิก')` เป็น logic (ดู C-07) ควรใช้ error code/type
6. **ไม่มี error boundary, ไม่มี logging/monitoring, ไม่มี telemetry ของ agent step** — debug ปัญหา production จะยากมาก
7. **ไม่มี test เลย** — `package.json` ไม่มี test runner (vitest/jest) ไม่มี ESLint/Prettier; โค้ดที่มี logic หนัก (prune, transform history, parse SSE, check_security) เป็น candidate ที่เทสต์ได้ทันทีและคุ้มมาก โดยเฉพาะ:
   - `check_security` — เคส bypass ที่รู้อยู่แล้ว (regression test)
   - `validate_workspace_path` — `..`, symlink, prefix (`D:\Pokemon_cli_evil`)
   - `replace_file_content` — LF/CRLF/BOM/ไม่เจอ/ซ้ำ
   - `prepare*History` — round-trip 3 ฟอร์แมต + switching provider
8. **ไม่มี CI / ไม่มี git** — ไม่มีประตูกัน regression และ Agent แก้ไฟล์แล้วย้อนกลับไม่ได้
9. **ไม่มีการสำรองข้อมูลก่อน Agent เขียนไฟล์** — `write_file`/`replace_file_content` เป็น destructive โดยไม่มี undo/backup (ควรมี snapshot หรือ revision log)

---

## 8. ✅ จุดที่ทำได้ดี (ควรรักษาไว้)

- แยกชั้น hook / service / component ชัดเจน อ่านง่าย และ `tsc --strict` ผ่านสะอาด (ไม่มี `any` หลุดใน UI layer)
- **Human-in-the-loop approval** ทำงานจริง: มี `pending_approval` → resolve/reject, ปุ่ม reject ทำให้ tool คืน error กลับให้โมเดลรับรู้ (ไม่ throw ทิ้ง) — เป็น pattern ที่ถูกต้อง
- **ฝั่ง Rust อ่าน stdout/stderr พร้อมกันด้วย task แยก** (`lib.rs:284-314`) — เลี่ยง deadlock ได้ถูกต้อง พร้อม timeout + `taskkill /T` และ `CREATE_NO_WINDOW`
- **มี workspace sandbox แนวคิดถูก** (canonicalize + เทียบ root) แค่ยังมีช่องโหว่ C-01
- **Streaming SSE parser จัดการ chunk ที่ถูกตัดกลางบรรทัดได้** (`buffer = lines.pop()`) — ถูกต้องตามหลัก
- **Rust validate path ก่อนเข้าถึงทุก tool ไฟล์** (ยกเว้น grep/find) และ sort directory ให้ dir ขึ้นก่อน
- **Abort/Stop มีการ reject approval ที่ค้างอยู่ทั้งหมด** (`useAgentChat.ts:53-57`) — จุดนี้คิดมาดี
- **การแยก diff preview ให้ผู้ใช้ก่อนอนุมัติ** เป็นแนวคิดที่ดีมาก (แค่ตัว diff ยังไม่จริงจัง)

---

## 9. ลำดับความสำคัญที่แนะนำให้แก้ก่อน (Priority Order)

| ลำดับ | ประเด็น | เหตุผล |
|---|---|---|
| 1 | C-01 (path prefix), H-01 (`check_security`) | ความปลอดภัย — เสี่ยงข้อมูลผู้ใช้หาย/ถูกเขียนทับ |
| 2 | C-02, C-03 (Claude thinking + tool context) | ฟีเจอร์หลักใช้ไม่ได้ / Agent ทำงานผิดบริบท |
| 3 | C-04, C-05 (Gemini thinking + `"null"`) | ฟีเจอร์ที่โฆษณาไว้ไม่ทำงาน + prompt เสีย |
| 4 | C-06, C-08 (CSP custom provider, cwd) | ผู้ใช้ต่างเครื่อง/ต่าง endpoint ใช้ไม่ได้ |
| 5 | H-02 (prune) | เกิด 400 แบบสุ่มหลังคุยไปหลายรอบ |
| 6 | C-07, H-04 (abort, send race) | UX/ความถูกต้องที่ผู้ใช้เจอบ่อย |
| 7 | H-03 (localStorage) | ประสิทธิภาพและความน่าเชื่อถือของการบันทึกประวัติ |
| 8 | H-08, H-09 (grep/find, atomic write) | ประสิทธิภาพ + ความปลอดภัยของไฟล์ |
| 9 | M-* ทั้งหมด | ความถูกต้อง/ความสม่ำเสมอ |
| 10 | เพิ่ม test + ESLint + git + CI | กันการถอยกลับของทุกข้อข้างบน |

---

## 10. สรุปส่งท้าย

โปรเจกต์นี้มี "โครง" ที่ดีและผ่านการคอมไพล์ครบ แต่ยังไม่พร้อมใช้งานจริงในฐานะ coding agent เพราะ:

- **ชั้นความปลอดภัยมีช่องที่ bypass ได้ทั้งสองชั้น** (sandbox path prefix + `check_security` prefix allow-list) และ Auto-Pilot เป็นค่าเริ่มต้น
- **ชั้น conversation history ยังไม่ถูกต้อง** ทั้งการแปลงฟอร์แมตข้ามเทิร์น ข้ามค่าย และการ prune — เป็นรากของบั๊กหลายตัวพร้อมกัน (C-03, C-05, M-02, M-03, H-02)
- **ไม่มี test/lint/CI/git** ทำให้ทุกการแก้ข้างต้นมีความเสี่ยงสูงที่จะทำให้ของเดิมพังโดยไม่รู้ตัว

**ยังไม่ได้แก้ไขโค้ดใด ๆ ตามที่ร้องขอ** — หากต้องการ ผมสามารถเริ่มจากลำดับที่ 1 (C-01, H-01) พร้อมเขียน regression test กำกับได้
