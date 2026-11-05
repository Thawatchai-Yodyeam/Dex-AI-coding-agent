<div align="center">

<img src="public/dex.svg" alt="Dex logo" width="96" height="96" />

# Dex — AI Coding Agent

**A desktop coding assistant that really reads, searches, edits files and runs commands in your project.**<br/>
Works with many providers (Claude · GPT · Gemini · DeepSeek · Qwen · Ollama/OpenRouter), connects to MCP servers and Skills, asks before anything risky, and can undo its file edits.

[![Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Rust](https://img.shields.io/badge/Rust-2021-000000?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)](#)

[Features](#-features) · [Getting started](#-getting-started) · [Usage](#-usage) · [Security](#-security) · [Architecture](#-architecture) · [Development](#-development)

</div>

---

## ✨ Features

| | |
|---|---|
| 🤖 **Many providers, one app** | Claude, GPT, Gemini, DeepSeek, Qwen and OpenAI-compatible endpoints (Ollama, LM Studio, OpenRouter). Switch models in the middle of a chat. |
| 🧠 **Adjustable thinking** | From *fast* to *maximum*, showing only the levels the model supports. You can expand its thinking to read it. |
| 🛠️ **Works on real files** | Reads long files in pages with line numbers, makes several edits at once, searches with regex or glob, and runs PowerShell, with a diff to review before you approve. |
| ⏱️ **Long and background commands** | Timeouts of up to 30 minutes, and dev servers can run in the background (stop them from the Terminal). |
| 🧩 **Skills and MCP** | Loads specialised instructions from `SKILL.md` and connects to MCP servers (stdio or HTTP) using a Claude Desktop style config. |
| 🛍️ **Customizations** | A marketplace in the sidebar for installing ready-made MCP servers and skills, with their keys kept in Credential Manager. |
| ↩️ **Undo file edits** | The **Undo file changes** button (or `/undo`) reverts files changed by tools and, if the workspace is a git repo, by shell commands too. |
| 🔁 **Regenerate and edit** | Regenerate an answer, or edit an earlier message and resend from there. The agent still remembers the tools it used in earlier turns. |
| 💾 **Picks up where you left off** | Full history, including tool results, is saved per chat, so you can switch chats or reopen the app and keep working. |
| 📎 **`@file`** | Type `@` in the chat box and pick a file. Its contents are attached right away, so the agent spends no step reading it. |
| 🌐 **Reads web pages** | The `web_fetch` tool reads docs, changelogs and issues (HTML is converted to text and split into pages). It asks before each new domain. |
| 🧭 **In-app browser** | A pane on the right (🗔 button, top right) lets the agent open your dev server and test it: read the page outline, click, type, press keys, check the console and errors, and take screenshots for models that can see images. You can use the URL bar yourself too. |
| 🎨 **Dex Design** | Ask for a website, app screen or prototype in chat and see it on a canvas beside the conversation. Switch between desktop, tablet and mobile, click part of the page to comment on it, compare options side by side, go back to old versions and export as HTML. The agent can open the page to check its own work. |
| 📄 **Word documents** | The `docx` tool reads and edits `.docx` files through the built-in G-docx editor, keeping the formatting it does not touch. |
| 📋 **Project instructions** | Put a `DEX.md` or `AGENTS.md` in the project root and the agent follows it every turn. |
| 🖼️ **Image attachments** | Paste with `Ctrl+V`, drag a file in, or use the attach button. Large images are resized automatically. |
| 🔐 **Asks before anything risky** | Auto-Pilot and Supervised modes, your own allow/deny rules, protection for secret files like `.env`, and API keys stored in Windows Credential Manager. |
| 💰 **Economical and resilient** | Claude prompt caching, automatic retries when an API is briefly down, summaries of old conversation when context runs low (recent turns stay whole), and a check-in every 50 steps. |
| 🔔 **Notifications** | Windows notifications when work finishes or needs approval while you are in another window. |
| 💻 **Built-in terminal** | Watch command output live and stop commands that hang. |
| 🎨 **Pokémon themes** | Light, dark or system, plus Pikachu, Poké Ball, Squirtle, Bulbasaur and Gengar. |
| 🌏 **Thai and English** | For both the interface and the language the agent replies in. |

## 🚀 Getting started

### Requirements

- [Node.js](https://nodejs.org) 20 or later
- [Rust](https://rustup.rs) (stable)
- [Tauri's Windows prerequisites](https://tauri.app/start/prerequisites/) (WebView2 and Microsoft C++ Build Tools)

### Install and run

```bash
git clone --recursive https://github.com/Thawatchai-Yodyeam/Dex-AI-coding-agent.git
cd Dex-AI-coding-agent
npm install
npm run tauri dev
```

Or double-click `run.bat`.

### Add an API key

There are two ways:

1. **In the app:** ⚙️ Settings → API Keys, then paste your key. It is stored encrypted in Windows Credential Manager, not localStorage. Keys from older versions are moved automatically.
2. **A `.env` file** in the folder you run the app from. The app loads the keys but does not save them to your machine. `.env` is already in `.gitignore`.

To use local models or OpenRouter: ⚙️ Settings → API Keys → **Custom endpoint**, then enter a Base URL (such as `http://localhost:11434/v1`) and model names separated by `,`. The model must support tool calling.

```env
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...          # or GOOGLE_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY
DEEPSEEK_API_KEY=...
DASHSCOPE_API_KEY=...       # Qwen (or QWEN_API_KEY)
```

## 📖 Usage

### Chat commands

| Command | What it does |
|---|---|
| `/help` | Shows the model, thinking level, workspace, project instructions file and available skills |
| `/undo` | Reverts the files the agent changed in the latest turn |
| `/clear` | Clears this conversation |
| `/skill-name message` | Uses that skill for this request right away |
| `@path` | Attaches a workspace file's contents to your message (type `@` and pick from the list; secret files and files under a deny rule are not attached) |

### Skills

A skill is a folder containing a `SKILL.md`, the same format as Agent Skills:

```markdown
---
name: release
description: Publish a new release. Use when the user asks to bump the version or write a changelog
---
1. Read CHANGELOG.md ...
```

Put it in `.dex/skills/<name>/` (or `.claude/skills/`) in a project, or in `~/.dex/skills/<name>/` for every project.
The agent sees only the name and description, and loads the full instructions with `use_skill` when the task matches. Turn each one on or off in ⚙️ Settings → Skills and MCP.

### MCP servers

Go to ⚙️ Settings → Skills and MCP and paste a config in the same format as Claude Desktop or `.mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/projects"] },
    "remote": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${MY_TOKEN}" } }
  }
}
```

- `${NAME}` in args, env, url and headers is replaced by a key saved in Customizations or by an environment variable, so tokens need not be kept in settings.
- MCP tools are named `mcp__<server>__<tool>` and **always ask before running**, except those that declare `readOnlyHint` in Auto-Pilot mode or have an allow rule of type *MCP tool*.
- stdio and Streamable HTTP are supported (the older SSE transport is not). Connection status and errors appear on the settings page.

### Customizations

Open **Customizations** in the sidebar to browse the **Marketplace** and manage what is **Installed**.

- **Before you install**, each plugin shows the exact command or URL it uses, who publishes it, and whether it comes from the community rather than the service's owner.
- **MCP plugins** add an entry to the same config as ⚙️ Settings → Skills and MCP, so you can still edit them there. Their tools ask before running under the usual rules.
- **Skill plugins** write `~/.dex/skills/<name>/SKILL.md`. They contain instructions only, and nothing runs. Dex never overwrites or deletes a skill you wrote yourself.
- **Keys** go to Windows Credential Manager as `mcp-secret-<NAME>`, and the config stores only `${NAME}`. A saved key takes priority over an environment variable of the same name. Uninstalling a plugin deletes its keys.
- **Requirements:** `npx` plugins need [Node.js](https://nodejs.org/) and `uvx` plugins need [uv](https://docs.astral.sh/uv/getting-started/installation/). Remote plugins and skills need neither.

To add a plugin, add it to `src/services/marketplace/catalog.ts`. `marketplace.test.ts` checks that its config parses and that it declares the keys it uses. Pass keys through `env` or `headers`, never `args`, because other programs on the computer can read process arguments.

### Project instructions (`DEX.md`)

Create this file in the workspace root. The app uses the first one it finds, in the order `DEX.md` → `AGENTS.md` → `CLAUDE.md`:

```markdown
# Rules for this project
- Use pnpm, not npm
- Run `pnpm test` after every code change
- Write comments in Thai
```

The file is read again every turn, so edits apply immediately (up to 20,000 characters).

### Undoing file edits

- Answers that changed files show an **N files changed** label and an **Undo file changes** button (press twice to confirm).
- Undoing an older turn also undoes every turn after it, so files really return to their state before that turn.
- If the workspace is a git repo, Dex takes a snapshot before the first shell command that might change files (shown as **incl. shell commands**), so undo also restores files that shell commands changed, created or deleted. The snapshot uses a temporary index, does not touch your stage, stash or branch, and skips files in `.gitignore`.
- After an undo, the agent is told in the next turn, so it knows to read those files again.

> [!NOTE]
> Checkpoints are kept in memory, so undo is no longer possible after closing the app. Files over 5 MB and non-text files show a warning that they cannot be undone.

### Dex Design

Type something like "design a landing page for a coffee shop" in chat, or press the 🎨 button at the top right to see all projects.

- Projects live in `.dex/designs/<name>/` in the workspace as plain HTML, CSS and JS, so you can open, edit and commit them like any other files.
- Each agent write becomes one version. The latest 30 are kept in `.versions/`, which stays out of git. View an old version from the toolbar and press **Use this version** to bring it back as a new version, so nothing is lost.
- The download button copies the design files to a folder you choose, without overwriting anything.
- **Comment on the page:** press the comment button on the toolbar, click part of the page, type what should change, then press **Send to Dex**. The agent knows which element you mean, and the pin disappears once it is done. Comments are kept in the project's `comments.json`.
- **Compare options:** ask for something like "give me 3 directions" and the agent creates each as its own page. Switch between them with the tabs, or press **Compare** to see them together.

### Attaching images

Attach up to 5 images per message (PNG, JPEG, WebP, GIF). Images with a long edge over 1568px are scaled down. DeepSeek cannot accept images yet, so the attach button is disabled for it.

> [!TIP]
> The chat view does not store images, because chats are saved to disk often while streaming. Reopened chats show an "Image (not saved)" label instead, but the agent still remembers the image from the history saved to file.

## 🔐 Security

Dex edits real files on your machine, so it has several layers of protection:

- **Sandbox:** all file tools work only inside the selected workspace (checked per path component, not just by prefix).
- **Secret files:** `.env`, `*.pem`, `id_rsa`, `.npmrc` and similar always need permission to read or edit, and `grep_search` skips them.
- **Shell commands:** read-only commands run straight away in Auto-Pilot. Commands that write or delete files, or chain several commands, ask first. Dangerous commands such as shutdown are always blocked.
- **Permission rules:** set your own allow and deny rules in ⚙️ Settings (shell, read file, edit file, MCP tool, web). Deny always wins. The *For this chat* and *Always allow* buttons create rules for you.
- **Supervised:** turn off Auto-Pilot (⚡ button, top right) and the agent asks before every file edit and command.
- **MCP:** servers start only from the config on the settings page (a project's `.mcp.json` is not read, so an unfamiliar project cannot make the app run programs), and MCP tools ask before running.
- **Web:** `web_fetch` asks before each new domain, even in Auto-Pilot, because a URL can be used to send data out. You can set allow rules such as `docs.rs` or `*.github.com`. Redirects are followed only within the same domain, and the agent is told that web content is data and that it must not follow instructions in it.
- **In-app browser:** pages in the pane cannot call Dex's commands (Tauri blocks external origins), and the pane cannot open Dex's own pages or `file://`. localhost opens straight away in Auto-Pilot, other sites ask first under the same domain rules as `web_fetch`, and running JavaScript on pages other than localhost needs approval every time.
- **Dex Design:** AI-written design pages open from a `127.0.0.1` server as an external origin, so they cannot call Dex's commands. You type comments in the app, not in the page, so a page cannot write requests on your behalf, and text from the page reaches the model marked as data. The server serves only project files through a URL with a random token, and a CSP stops pages sending data out with `fetch` or forms (images, fonts and libraries can still load from CDNs). File writes follow the same permission rules and Supervised mode as normal edits.
- **API keys:** stored in Windows Credential Manager, not localStorage.

## 🧩 Architecture

```mermaid
flowchart LR
    UI["React UI<br/>Composer · Chat · Terminal"] --> Hook["useAgentChat<br/>streaming · approvals · checkpoints"]
    Hook --> Svc["AgentService<br/>per-provider history · DEX.md"]
    Svc --> P1["Claude"]
    Svc --> P2["GPT / DeepSeek / Qwen"]
    Svc --> P3["Gemini"]
    Svc --> Tools["tools.ts<br/>schemas + approval policy"]
    Svc --> Skills["skills.ts<br/>SKILL.md"]
    Svc --> MCP["mcp/manager.ts<br/>JSON-RPC client"]
    Tools -->|invoke| Rust["Rust (Tauri)<br/>sandbox · shell · files · search · git snapshot"]
    MCP -->|stdio / HTTP| Rust
```

<details>
<summary><b>File structure</b></summary>

```
src/
  App.tsx                   main layout + wires the hooks together
  App.css                   themes (design tokens, light/dark + Pokémon themes)
  components/               Sidebar, TopBar, Composer, ChatMessageItem, DiffViewer, SettingsModal,
                            SkillsSettings, McpSettings, ModelOptions, BrowserPane, DesignCanvas,
                            CustomizationsPage, PluginDialog, ...
  hooks/
    useAppSettings.ts       settings, keys in Credential Manager/.env, keeps MCP servers in sync with config
    useChatSessions.ts      chat history (saves only changed chats, warns when saving fails) + loads native history from file
    useFileMentions.ts      file list when typing @ in the chat box
    useAgentChat.ts         send / stream / approve / stop / checkpoint + undo / regenerate / notifications
  services/
    tauriBridge.ts          calls to Rust commands
    sessionStore.ts         one file per chat in app data (moved from localStorage automatically)
    agent/
      AgentService.ts       native per-provider history, export/restore/rewind, step limit, merges a turn's tools
      tools.ts              tool schemas + handlers + approval policy + runs read-only tools in parallel
      history.ts            converts/trims history + clears old tool results to fit the context budget
      compaction.ts         summarises old turns with the model when history is nearly full
      mentions.ts           attaches the contents of files the user @-mentions
      retry.ts              retries on 429/5xx/529/network loss (exponential backoff + retry-after)
      skills.ts             finds/reads SKILL.md, use_skill tool, /skill-name
      prompt.ts             system prompt + project instructions + skill list
      providers/            anthropic.ts (prompt caching), openai.ts (+ custom endpoint), google.ts
    browser/
      pane.ts               browser pane state + follows the frame's position in the layout
      actions.ts            browser tool actions (navigate/snapshot/click/type/...) over the DevTools protocol
      pageScripts.ts        scripts that run in the page (outline + refs, console capture)
    docx/
      editor.ts             docx tool talks to G-docx (plugins/gdocx, a git submodule) in the browser pane
    design/
      canvas.ts             canvas state: projects, versions, comment mode and screen size emulation in the browser pane
      comments.ts           stores comments + checks data from the page + builds the message sent to chat
      commentScripts.ts     comment mode scripts that run in the design page (highlight, clicks, pins)
      guidelines.ts         design guidelines given to the model when a project is created or opened
    mcp/
      config.ts             reads Claude Desktop style config
      client.ts             JSON-RPC client + stdio / Streamable HTTP transports
      manager.ts            starts/stops servers, merges tools as mcp__server__tool
    marketplace/
      catalog.ts            the plugins in the Marketplace (data only)
      skillPacks.ts         instructions of the skills that ship with the Marketplace
      plugins.ts            install state read from the real config/folders, install/uninstall/enable
  utils/
    images.ts               reads/resizes images before attaching
    notify.ts               Windows notifications
    i18n.ts                 Thai and English strings
src-tauri/src/lib.rs        Rust commands: shell (timeout/background), files (sandbox, paging, multi-edit),
                            search (regex/glob), git snapshot, keyring, skills, MCP transport, web_fetch,
                            browser pane (child webview + WebView2 DevTools protocol), design server (+ unit tests)
```

</details>

## 🧪 Development

```bash
npm run typecheck                                    # type check
npm run lint                                         # ESLint
npm test                                             # vitest
npm run build                                        # build the web app (needed before cargo test)
cargo test --manifest-path src-tauri/Cargo.toml --lib  # Rust tests
npm run tauri build                                  # create the installer
```

---

<div align="center">
<sub>Built with Tauri + React · Dex works on real files on your machine, so review before you approve.</sub>
</div>
