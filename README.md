# Dex — AI Coding Agent (Tauri v2 + React 19)

แอปเดสก์ท็อปผู้ช่วยเขียนโค้ดแบบหลายค่าย (Gemini, Claude, OpenAI และ OpenAI-compatible) ที่อ่าน/ค้นหา/แก้ไฟล์และรัน PowerShell ใน Workspace ได้ พร้อมระบบขออนุมัติก่อนทำสิ่งที่เสี่ยง

## รัน

```bash
npm install
npm run tauri dev
```

## โครงสร้าง

```
src/
  App.tsx                 layout หลัก + เชื่อม hooks
  App.css                 ธีม (design tokens, light/dark)
  components/             UI (Sidebar, TopBar, Composer, ChatMessageItem, SettingsModal, ...)
  hooks/
    useAppSettings.ts     settings + โหลดคีย์จาก .env (ไม่บันทึกคีย์จาก .env ลงเครื่อง)
    useChatSessions.ts    ประวัติแชท (บันทึกแบบ debounce)
    useAgentChat.ts       ส่งข้อความ / สตรีม / อนุมัติ tool / หยุด
  services/
    tauriBridge.ts        เรียกคำสั่งฝั่ง Rust
    agent/
      AgentService.ts     จัดการประวัติ (native ต่อ provider) และ rollback เมื่อยกเลิก/ล้มเหลว
      tools.ts            tool schema ชุดเดียว + handler + นโยบายอนุมัติ
      history.ts          แปลง/ตัดประวัติโดยไม่ทำให้คู่ tool call/result ขาด
      providers/          google.ts, anthropic.ts, openai.ts
src-tauri/src/lib.rs      คำสั่ง Rust: shell, ไฟล์ (sandbox), ค้นหา, security check (+ unit tests)
```

## ตรวจสอบ

```bash
npx tsc --noEmit
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
```
