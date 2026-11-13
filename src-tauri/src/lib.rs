use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Default)]
pub struct AppState {
    pub running_processes: Arc<Mutex<HashMap<String, u32>>>,
    pub cancelled_ids: Arc<Mutex<HashSet<String>>>,
    /// คำสั่งที่รันเบื้องหลัง (dev server ฯลฯ) — output ที่ agent ยังไม่ได้อ่าน
    pub background: Arc<Mutex<HashMap<String, Arc<Mutex<BackgroundOutput>>>>>,
    /// MCP server แบบ stdio ที่เปิดอยู่ (key = id ที่ frontend ตั้ง)
    pub mcp: Arc<Mutex<HashMap<String, McpProcess>>>,
}

pub struct McpProcess {
    pid: u32,
    stdin: Arc<tokio::sync::Mutex<tokio::process::ChildStdin>>,
}

/// output ที่ยังไม่ถูกอ่านของคำสั่งเบื้องหลัง เก็บไม่เกิน MAX_BACKGROUND_BUFFER (ทิ้งส่วนเก่าสุด)
#[derive(Default)]
pub struct BackgroundOutput {
    pending: String,
    dropped_bytes: usize,
    exit_code: Option<i32>,
    finished: bool,
}

const MAX_BACKGROUND_BUFFER: usize = 64 * 1024;

impl BackgroundOutput {
    fn push_line(&mut self, line: &str) {
        self.pending.push_str(line);
        self.pending.push('\n');
        if self.pending.len() > MAX_BACKGROUND_BUFFER {
            let mut cut = self.pending.len() - MAX_BACKGROUND_BUFFER;
            while !self.pending.is_char_boundary(cut) {
                cut += 1;
            }
            self.pending.drain(..cut);
            self.dropped_bytes += cut;
        }
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct BackgroundSnapshot {
    /// output ใหม่ตั้งแต่อ่านครั้งก่อน
    pub output: String,
    /// ไบต์ที่ถูกทิ้งเพราะไม่ได้อ่านนานเกินไป
    pub dropped_bytes: usize,
    pub running: bool,
    pub exit_code: Option<i32>,
}

#[derive(Serialize, Clone)]
pub struct ShellOutputEvent {
    pub id: String,
    pub stream: String, // "stdout" | "stderr" | "exit" | "error"
    pub text: String,
    pub exit_code: Option<i32>,
}

#[derive(Serialize)]
pub struct ShellResult {
    pub success: bool,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SecurityCheckResult {
    pub safe: bool,
    pub reason: Option<String>,
    pub high_risk: bool,
    pub is_read_only: bool,
    /// มีตัวเชื่อมคำสั่ง/redirection — กฎ allow ของผู้ใช้จะไม่ใช้กับคำสั่งแบบนี้
    pub has_chaining: bool,
}

/// แปลงพาธเป็นรูปแบบเปรียบเทียบได้ (ลบ \\?\, ใช้ \ เป็นตัวคั่น, ตัวพิมพ์เล็ก, ไม่มี \ ท้าย)
fn normalize_for_compare(p: &Path) -> String {
    let s = p
        .to_string_lossy()
        .replace(r"\\?\", "")
        .replace('/', "\\")
        .to_lowercase();
    s.trim_end_matches('\\').to_string()
}

/// เช็คว่า target อยู่ใต้ root จริงตามขอบเขต component
/// (ป้องกัน `d:\ws_evil` ผ่านการเช็คเมื่อ root คือ `d:\ws`)
fn is_within(target: &Path, root: &Path) -> bool {
    let t = normalize_for_compare(target);
    let r = normalize_for_compare(root);
    t == r || t.starts_with(&format!("{}\\", r))
}

fn resolve_workspace_root(workspace: Option<&str>) -> PathBuf {
    match workspace {
        Some(ws) if !ws.trim().is_empty() => PathBuf::from(ws.trim()),
        _ => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    }
}

// ---------- ไฟล์ลับ (API key, private key, credential) ----------
// อ่าน/เขียนไฟล์เหล่านี้ต้องได้รับอนุญาตจากผู้ใช้ก่อนเสมอ (frontend ส่ง allow_sensitive หลังผู้ใช้อนุมัติ)

/// ข้อความ error ขึ้นต้นด้วย prefix นี้ — frontend ใช้แยกว่าต้องขออนุมัติ
const SENSITIVE_PREFIX: &str = "SENSITIVE_FILE:";
const SENSITIVE_EXTS: [&str; 8] = ["env", "pem", "key", "p12", "pfx", "keystore", "jks", "kdbx"];
const SENSITIVE_NAMES: [&str; 12] = [
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".netrc", "_netrc", ".npmrc", ".pypirc",
    ".git-credentials", "credentials", "credentials.json", ".htpasswd",
];
const SENSITIVE_DIRS: [&str; 3] = [".ssh", ".aws", ".gnupg"];
/// `.env.example` ฯลฯ เป็นแม่แบบ ไม่มีความลับจริง
const ENV_TEMPLATE_SUFFIXES: [&str; 5] = ["example", "sample", "template", "dist", "defaults"];

fn is_sensitive_name(name: &str) -> bool {
    let n = name.to_lowercase();
    if n == ".env" {
        return true;
    }
    if let Some(suffix) = n.strip_prefix(".env.") {
        let last = suffix.rsplit('.').next().unwrap_or("");
        return !ENV_TEMPLATE_SUFFIXES.contains(&last);
    }
    if SENSITIVE_NAMES.contains(&n.as_str()) {
        return true;
    }
    match n.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => SENSITIVE_EXTS.contains(&ext),
        _ => false,
    }
}

fn is_sensitive_path(p: &Path) -> bool {
    let in_secret_dir = p.components().any(|c| match c {
        Component::Normal(s) => SENSITIVE_DIRS.contains(&s.to_string_lossy().to_lowercase().as_str()),
        _ => false,
    });
    in_secret_dir || p.file_name().map(|n| is_sensitive_name(&n.to_string_lossy())).unwrap_or(false)
}

/// เช็คทั้งพาธที่ส่งมาและปลายทางจริง (กัน symlink ชื่อธรรมดาที่ชี้ไป .env)
fn ensure_not_sensitive(path: &Path, allow_sensitive: Option<bool>) -> Result<(), String> {
    if allow_sensitive.unwrap_or(false) {
        return Ok(());
    }
    let real = fs::canonicalize(path).ok();
    if is_sensitive_path(path) || real.as_deref().map(is_sensitive_path).unwrap_or(false) {
        return Err(format!(
            "{} ไฟล์นี้อาจมีความลับ (เช่น API key) ต้องได้รับอนุญาตจากผู้ใช้ก่อน: {}",
            SENSITIVE_PREFIX,
            path.display()
        ));
    }
    Ok(())
}

/// ยุบ `.` และ `..` แบบไม่แตะดิสก์ (ใช้กับพาธที่อาจยังไม่มีอยู่หรือมี wildcard)
fn lexical_normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// ตรวจสอบและจำกัดขอบเขตไฟล์ให้อยู่ภายใน Workspace ป้องกัน Path Traversal
fn validate_workspace_path(path_str: &str, workspace_str: Option<&str>) -> Result<PathBuf, String> {
    let raw_path = path_str.trim();
    if raw_path.is_empty() {
        return Err("พาธของไฟล์ต้องไม่เป็นค่าว่าง".to_string());
    }

    let ws_root = resolve_workspace_root(workspace_str);

    let target_path = Path::new(raw_path);
    let full_path = if target_path.is_absolute() {
        target_path.to_path_buf()
    } else {
        ws_root.join(target_path)
    };

    // ปรับเทียบมาตรฐาน (Normalize canonical path)
    let canonical_ws = fs::canonicalize(&ws_root).unwrap_or_else(|_| ws_root.clone());
    
    let canonical_target = if full_path.exists() {
        fs::canonicalize(&full_path).map_err(|e| format!("ไม่สามารถเข้าถึงพาธ {}: {}", raw_path, e))?
    } else {
        // หากไฟล์ยังไม่ถูกสร้าง ให้เช็คว่า Parent ที่มีอยู่จริงอยู่ใต้ Workspace หรือไม่
        let mut curr = full_path.clone();
        loop {
            if curr.exists() {
                let canon = fs::canonicalize(&curr).map_err(|e| format!("ไม่สามารถเข้าถึงไดเรกทอรี: {}", e))?;
                break canon;
            }
            match curr.parent() {
                Some(p) => curr = p.to_path_buf(),
                None => break ws_root.clone(),
            }
        }
    };

    if !is_within(&canonical_target, &canonical_ws) {
        return Err(format!(
            "ความปลอดภัย: ไม่อนุญาตให้เข้าถึงไฟล์นอก Workspace!\nเป้าหมาย: {}\nWorkspace: {}",
            raw_path,
            ws_root.display()
        ));
    }

    Ok(full_path)
}

// 1. ตรวจสอบความปลอดภัยของคำสั่ง (Hard Blocked vs Safe Read-Only vs Modifying)
//
// หมายเหตุ: นี่คือการคัดกรองแบบ best-effort ไม่ใช่ sandbox — คำสั่งใดที่ไม่ใช่ read-only
// จะต้องได้รับการอนุมัติจากผู้ใช้เสมอ (ฝั่ง frontend) ฉะนั้นทางที่ปลอดภัยคือ "ไม่แน่ใจ = ไม่ใช่ read-only"
#[tauri::command]
fn check_security(command: String, workspace: Option<String>) -> SecurityCheckResult {
    let lower = command.to_lowercase();
    // ยุบ whitespace ทั้งหมดให้เหลือช่องว่างเดียว เพื่อไม่ให้หลบ pattern ด้วยการเว้นวรรคซ้ำ
    let normalized = lower.split_whitespace().collect::<Vec<_>>().join(" ");
    let tokens: Vec<&str> = normalized.split(' ').filter(|t| !t.is_empty()).collect();

    // 1.1 คำสั่งอันตรายร้ายแรงต่อระบบ บล็อกเด็ดขาด
    let blocked_commands = [
        "format-volume", "diskpart", "stop-computer", "restart-computer", "shutdown",
        "bcdedit", "clear-disk", "initialize-disk", "remove-partition",
    ];
    let blocked_phrases = [
        "rm -rf /", "--no-preserve-root", "vssadmin delete", "reg delete hklm", "reg delete hkcu",
        "rmdir /s /q c:", "rd /s /q c:", "del /s /q c:", "remove-item -recurse -force c:",
    ];

    let hit = tokens
        .iter()
        .map(|t| t.trim_matches(|c: char| c == '"' || c == '\'' || c == '(' || c == ')' || c == ';'))
        .find(|t| blocked_commands.contains(t))
        .map(|t| t.to_string())
        .or_else(|| blocked_phrases.iter().find(|p| normalized.contains(*p)).map(|p| p.to_string()));

    if let Some(pattern) = hit {
        return SecurityCheckResult {
            safe: false,
            reason: Some(format!("คำสั่งมีความเสี่ยงทำลายระบบ ถูกบล็อกเด็ดขาด: {}", pattern)),
            high_risk: true,
            is_read_only: false,
            has_chaining: false,
        };
    }

    // 1.2 ตัวแบ่งคำสั่ง / redirection / sub-shell / ขึ้นบรรทัดใหม่ (PowerShell ถือว่า newline = คำสั่งใหม่)
    let has_chaining_or_redirect = ['\n', '\r', ';', '&', '>', '<', '|', '`']
        .iter()
        .any(|c| lower.contains(*c))
        || lower.contains("$(")
        || lower.contains("${")
        || lower.contains("@(");

    // 1.3 คำสั่ง read-only ที่อนุญาตให้รันอัตโนมัติ (เทียบ "คำแรก" แบบตรงตัว ไม่ใช่ prefix ของสตริง)
    let first = tokens.first().copied().unwrap_or("");
    let second = tokens.get(1).copied().unwrap_or("");
    let read_only_commands = [
        "dir", "ls", "pwd", "get-childitem", "gci", "get-content", "gc", "type", "cat",
        "get-location", "whoami", "get-command", "where.exe", "echo", "write-output",
        "test-path", "get-item", "resolve-path", "select-string",
    ];
    let version_tools = ["node", "npm", "pnpm", "yarn", "cargo", "rustc", "python", "git", "tsc"];

    // `$env:OPENAI_API_KEY` ฯลฯ — ตัวแปรอาจขยายเป็นความลับหรือพาธนอก workspace
    let ws = resolve_workspace_root(workspace.as_deref());
    let is_safe_read_only = !has_chaining_or_redirect
        && !lower.contains('$')
        && path_args_stay_in_workspace(first, tokens.get(1..).unwrap_or(&[]), &ws)
        && (read_only_commands.contains(&first)
            || (version_tools.contains(&first)
                && tokens.len() == 2
                && (second == "-v" || second == "--version"))
            || (first == "git" && is_read_only_git(&tokens[1..])));

    if is_safe_read_only {
        return SecurityCheckResult {
            safe: true,
            reason: None,
            high_risk: false,
            is_read_only: true,
            has_chaining: false,
        };
    }

    // 1.4 คำสั่งอื่นๆ ที่อาจมีการเขียน/ลบ/แก้ไข หรือรันสคริปต์ → ต้องอนุมัติเสมอ
    let destructive_words = [
        "del", "erase", "rd", "rmdir", "rm", "remove-item", "ri", "move-item", "mv",
        "set-content", "out-file", "clear-content",
    ];
    let is_moderate_risk = has_chaining_or_redirect
        || tokens.iter().any(|t| destructive_words.contains(t))
        || normalized.contains("git reset")
        || normalized.contains("git clean")
        || normalized.contains("git push")
        || normalized.contains("drop table")
        || normalized.contains("truncate");

    SecurityCheckResult {
        safe: true,
        reason: Some(if has_chaining_or_redirect {
            "คำสั่งมีตัวเชื่อมคำสั่งหรือ Redirection หลายขั้นตอน ควรตรวจสอบก่อนดำเนินการ".to_string()
        } else if is_moderate_risk {
            "คำสั่งนี้มีการลบหรือปรับเปลี่ยนไฟล์ ควรตรวจสอบก่อนดำเนินการ".to_string()
        } else {
            "คำสั่งนี้มีการทำงานหรือแก้ไขระบบ".to_string()
        }),
        high_risk: is_moderate_risk,
        is_read_only: false,
        has_chaining: has_chaining_or_redirect,
    }
}

/// คำสั่ง read-only ที่รับพาธ — ต้องชี้อยู่ใน workspace เท่านั้นถึงจะรันอัตโนมัติได้
const PATH_COMMANDS: [&str; 12] = [
    "dir", "ls", "get-childitem", "gci", "get-content", "gc", "type", "cat", "test-path", "get-item",
    "resolve-path", "select-string",
];
/// คำสั่งที่อ่าน "เนื้อหา" ไฟล์ — ห้ามแตะไฟล์ลับด้วย
const CONTENT_COMMANDS: [&str; 5] = ["get-content", "gc", "type", "cat", "select-string"];

fn path_args_stay_in_workspace(command: &str, args: &[&str], ws: &Path) -> bool {
    if !PATH_COMMANDS.contains(&command) {
        return true;
    }
    let reads_content = CONTENT_COMMANDS.contains(&command);
    args.iter().all(|token| {
        // `-Path:C:\x` → ตรวจค่าหลัง ':' ส่วน flag เฉย ๆ ข้ามไป (ค่าที่ตามมาเป็น token ถัดไปซึ่งถูกตรวจอยู่แล้ว)
        let value = match token.strip_prefix('-') {
            Some(flag) => match flag.split_once(':') {
                Some((_, v)) => v,
                None => return true,
            },
            None => token,
        };
        value.split(',').all(|a| !arg_escapes_workspace(a, ws, reads_content))
    })
}

const WILDCARDS: [char; 4] = ['*', '?', '[', ']'];

fn arg_escapes_workspace(arg: &str, ws: &Path, reads_content: bool) -> bool {
    let a = arg.trim_matches(|c: char| c == '"' || c == '\'');
    if a.is_empty() {
        return false;
    }
    // sub-expression, ตัวแปร, home, UNC และพาธจาก root ของไดรฟ์ปัจจุบัน
    if a.chars().any(|c| "(){}@$~%".contains(c)) || a.starts_with('\\') || a.starts_with('/') {
        return true;
    }
    let b = a.as_bytes();
    let drive_abs = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/');
    // `env:`, `hkcu:\`, `c:foo` — provider/drive-relative ของ PowerShell อ่านตัวแปรระบบหรือ registry ได้
    if a.contains(':') && !(drive_abs && !a[2..].contains(':')) {
        return true;
    }
    if reads_content && a.contains(WILDCARDS) {
        // อนุญาตเฉพาะ wildcard ที่จบด้วยนามสกุลธรรมดา เช่น `*.ts` — `*` หรือ `.e*` อาจกวาด .env ไปด้วย
        let suffix = &a[a.rfind(WILDCARDS).map(|i| i + 1).unwrap_or(0)..];
        if !suffix.starts_with('.') || suffix.contains(['\\', '/']) || is_sensitive_name(&format!("x{}", suffix)) {
            return true;
        }
    }
    let candidate = lexical_normalize(&if drive_abs { PathBuf::from(a) } else { ws.join(a) });
    let resolved = fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.clone());
    let ws_canon = fs::canonicalize(ws).unwrap_or_else(|_| ws.to_path_buf());
    if !(is_within(&resolved, &ws_canon) || is_within(&resolved, ws)) {
        return true;
    }
    reads_content && (is_sensitive_path(&candidate) || is_sensitive_path(&resolved))
}

/// git subcommand ที่อ่านอย่างเดียวจริง (ไม่รวม flag ที่เขียนไฟล์หรือเปลี่ยน ref)
fn is_read_only_git(args: &[&str]) -> bool {
    let sub = match args.first() {
        Some(s) => *s,
        None => return false,
    };
    let rest = &args[1..];
    match sub {
        "status" | "log" | "show" | "blame" | "rev-parse" | "ls-files" => {
            !rest.iter().any(|a| a.starts_with("--output"))
        }
        "diff" => !rest.iter().any(|a| a.starts_with("--output") || *a == "--ext-diff"),
        // git branch อ่านอย่างเดียวเฉพาะตอน list (ไม่มี argument เชิงตำแหน่งหรือ flag ลบ/ย้าย)
        "branch" => rest
            .iter()
            .all(|a| matches!(*a, "-a" | "-r" | "-v" | "-vv" | "--all" | "--list" | "--show-current")),
        _ => false,
    }
}

/// timeout สูงสุดที่ agent ขอได้ (build ใหญ่ ๆ ครั้งแรกอาจนานหลายนาที)
const MAX_TIMEOUT_SECS: u64 = 1800;

fn powershell_command(command: &str, cwd: Option<&str>) -> Command {
    let working_dir = match cwd {
        Some(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
        _ => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    };
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command])
        .current_dir(&working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW ป้องกัน Console สีดำเด้ง
    cmd
}

// 2. รันคำสั่งผ่าน PowerShell พร้อมสตรีม Output และป้องกัน Deadlock ด้วย Timeout
#[tauri::command]
async fn execute_command(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    command: String,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<ShellResult, String> {
    let mut cmd = powershell_command(&command, cwd.as_deref());

    // ตรวจสอบว่าคำสั่งถูกสั่งยกเลิกล่วงหน้าหรือไม่
    let pre_cancelled = {
        let mut cancelled = state.cancelled_ids.lock().unwrap();
        cancelled.remove(&id)
    };
    if pre_cancelled {
        return Err("คำสั่งถูกยกเลิกก่อนเริ่มทำงาน".to_string());
    }

    let mut child = cmd.spawn().map_err(|e| format!("ไม่สามารถเรียกใช้ powershell ได้: {}", e))?;

    let pid = child.id().unwrap_or(0);

    // ล็อก running_processes ก่อน cancelled_ids เสมอ (ลำดับเดียวกับ kill_command)
    // เพื่อให้การเช็ค "ถูกยกเลิกแล้วหรือยัง" กับการลงทะเบียน process เป็น atomic ไม่มีช่องว่างให้ kill หลุด
    let post_cancelled = {
        let mut processes = state.running_processes.lock().unwrap();
        let mut cancelled = state.cancelled_ids.lock().unwrap();
        let was_cancelled = cancelled.remove(&id);
        if !was_cancelled {
            processes.insert(id.clone(), pid);
        }
        was_cancelled
    };

    if post_cancelled {
        kill_process_tree(pid);
        let _ = child.kill().await;
        return Err("คำสั่งถูกยกเลิกระหว่างเริ่มทำงาน".to_string());
    }

    let stdout = child.stdout.take().ok_or("ไม่สามารถจับ stdout ได้")?;
    let stderr = child.stderr.take().ok_or("ไม่สามารถจับ stderr ได้")?;

    let mut stdout_reader = BufReader::new(stdout).lines();
    let mut stderr_reader = BufReader::new(stderr).lines();

    let app_handle_clone1 = app.clone();
    let id_clone1 = id.clone();
    let stdout_task = tokio::spawn(async move {
        let mut full_stdout = String::new();
        while let Ok(Some(line)) = stdout_reader.next_line().await {
            full_stdout.push_str(&line);
            full_stdout.push('\n');
            let _ = app_handle_clone1.emit("shell-output", ShellOutputEvent {
                id: id_clone1.clone(),
                stream: "stdout".to_string(),
                text: line,
                exit_code: None,
            });
        }
        full_stdout
    });

    let app_handle_clone2 = app.clone();
    let id_clone2 = id.clone();
    let stderr_task = tokio::spawn(async move {
        let mut full_stderr = String::new();
        while let Ok(Some(line)) = stderr_reader.next_line().await {
            full_stderr.push_str(&line);
            full_stderr.push('\n');
            let _ = app_handle_clone2.emit("shell-output", ShellOutputEvent {
                id: id_clone2.clone(),
                stream: "stderr".to_string(),
                text: line,
                exit_code: None,
            });
        }
        full_stderr
    });

    // Timeout ป้องกันคำสั่งประเภท Server หรือ Interactive Process แขวนค้าง
    let limit_secs = timeout_secs.unwrap_or(120).clamp(1, MAX_TIMEOUT_SECS);
    let wait_result = tokio::time::timeout(Duration::from_secs(limit_secs), child.wait()).await;

    // เคลียร์ออกจาก running processes
    {
        let mut processes = state.running_processes.lock().unwrap();
        processes.remove(&id);
    }

    let status = match wait_result {
        Ok(res) => res.map_err(|e| format!("เกิดข้อผิดพลาดระหว่างรอคำสั่ง: {}", e))?,
        Err(_) => {
            // หมดเวลา Kill process ทันที
            kill_process_tree(pid);
            let _ = child.kill().await;
            let _ = app.emit("shell-output", ShellOutputEvent {
                id: id.clone(),
                stream: "error".to_string(),
                text: format!("--- Command timed out after {}s (Process terminated) ---", limit_secs),
                exit_code: Some(-999),
            });
            return Err(format!("คำสั่งใช้เวลานานเกินกำหนด (Timeout {}s) และถูกยกเลิกแล้ว", limit_secs));
        }
    };

    let exit_code = status.code().unwrap_or(-1);
    let full_stdout = stdout_task.await.unwrap_or_default();
    let full_stderr = stderr_task.await.unwrap_or_default();

    let _ = app.emit("shell-output", ShellOutputEvent {
        id: id.clone(),
        stream: "exit".to_string(),
        text: format!("Process exited with code {}", exit_code),
        exit_code: Some(exit_code),
    });

    Ok(ShellResult {
        success: exit_code == 0,
        exit_code,
        stdout: full_stdout,
        stderr: full_stderr,
    })
}

fn emit_line(app: &AppHandle, id: &str, stream: &str, text: String) {
    let _ = app.emit("shell-output", ShellOutputEvent {
        id: id.to_string(),
        stream: stream.to_string(),
        text,
        exit_code: None,
    });
}

// 2.1 รันคำสั่งเบื้องหลัง (dev server, watcher) — คืนทันที output สะสมไว้ให้ read_background_output
// และยังสตรีมเข้า Terminal เหมือนคำสั่งปกติ ไม่มี timeout (หยุดด้วย kill_command หรือปิดแอป)
#[tauri::command]
async fn start_background_command(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    command: String,
    cwd: Option<String>,
) -> Result<u32, String> {
    let mut child = powershell_command(&command, cwd.as_deref())
        .spawn()
        .map_err(|e| format!("ไม่สามารถเรียกใช้ powershell ได้: {}", e))?;
    let pid = child.id().unwrap_or(0);
    let buffer = Arc::new(Mutex::new(BackgroundOutput::default()));
    state.running_processes.lock().unwrap().insert(id.clone(), pid);
    {
        let mut bg = state.background.lock().unwrap();
        // แชทยาว ๆ อาจเปิดคำสั่งเบื้องหลังหลายตัว — ลบตัวที่จบไปแล้วทิ้ง
        bg.retain(|_, out| !out.lock().unwrap().finished);
        bg.insert(id.clone(), buffer.clone());
    }

    let stdout = child.stdout.take().ok_or("ไม่สามารถจับ stdout ได้")?;
    let stderr = child.stderr.take().ok_or("ไม่สามารถจับ stderr ได้")?;
    for (reader, stream) in [
        (Box::new(stdout) as Box<dyn tokio::io::AsyncRead + Unpin + Send>, "stdout"),
        (Box::new(stderr), "stderr"),
    ] {
        let app = app.clone();
        let id = id.clone();
        let buffer = buffer.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                buffer.lock().unwrap().push_line(&line);
                emit_line(&app, &id, stream, line);
            }
        });
    }

    let running = state.running_processes.clone();
    tokio::spawn(async move {
        let code = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
        running.lock().unwrap().remove(&id);
        {
            let mut out = buffer.lock().unwrap();
            out.exit_code = Some(code);
            out.finished = true;
        }
        let _ = app.emit("shell-output", ShellOutputEvent {
            id,
            stream: "exit".to_string(),
            text: format!("Process exited with code {}", code),
            exit_code: Some(code),
        });
    });
    Ok(pid)
}

// 2.2 อ่าน output ใหม่ของคำสั่งเบื้องหลัง (อ่านแล้วล้าง — ครั้งถัดไปได้เฉพาะส่วนที่ออกมาเพิ่ม)
#[tauri::command]
fn read_background_output(state: State<'_, AppState>, id: String) -> Result<BackgroundSnapshot, String> {
    let bg = state.background.lock().unwrap();
    let buffer = bg.get(&id).ok_or_else(|| format!("ไม่พบคำสั่งเบื้องหลัง id {}", id))?;
    let mut out = buffer.lock().unwrap();
    let snapshot = BackgroundSnapshot {
        output: std::mem::take(&mut out.pending),
        dropped_bytes: std::mem::take(&mut out.dropped_bytes),
        running: !out.finished,
        exit_code: out.exit_code,
    };
    Ok(snapshot)
}

// 3. ฆ่า Process คำสั่งที่กำลังรันอยู่
#[tauri::command]
fn kill_command(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let mut processes = state.running_processes.lock().unwrap();
    if let Some(pid) = processes.remove(&id) {
        drop(processes);
        kill_process_tree(pid);
        return Ok(true);
    }
    // ยังไม่ได้ลงทะเบียน (กำลัง spawn) หรือจบไปแล้ว: จดไว้ให้ execute_command เห็น
    let mut cancelled = state.cancelled_ids.lock().unwrap();
    if cancelled.len() > 256 {
        // id ที่จบไปแล้วจะไม่มีใครมาลบ — กันไม่ให้โตไม่จำกัด
        cancelled.clear();
    }
    cancelled.insert(id);
    Ok(true)
}

fn kill_process_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(0x08000000)
            .output();
    }
}

/// เขียนไฟล์แบบ atomic: เขียนลงไฟล์ชั่วคราวข้างๆ แล้ว rename ทับ
/// ถ้าแอปดับกลางคัน ไฟล์เดิมจะไม่เสียหาย
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let tmp = path.with_file_name(format!(".{}.dex-tmp", file_name));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e
    })
}

// 4. อ่านเนื้อหาไฟล์ พร้อมระบบ Workspace Sandboxing
#[tauri::command]
fn read_file(path: String, workspace: Option<String>, allow_sensitive: Option<bool>) -> Result<String, String> {
    let valid_path = validate_workspace_path(&path, workspace.as_deref())?;
    ensure_not_sensitive(&valid_path, allow_sensitive)?;
    fs::read_to_string(&valid_path).map_err(|e| format!("ไม่สามารถอ่านไฟล์ {}: {}", valid_path.display(), e))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct FileSlice {
    /// บรรทัดที่อ่านได้ นำหน้าด้วยเลขบรรทัด + tab
    pub content: String,
    pub start_line: usize,
    /// 0 = ไม่มีบรรทัดในช่วงที่ขอ
    pub end_line: usize,
    pub total_lines: usize,
    /// จำนวนบรรทัดที่ยาวเกินและถูกตัดท้าย
    pub truncated_lines: usize,
}

const MAX_LINE_CHARS: usize = 2000;

/// ตัดสตริงที่ขอบ char (ไม่ตัดกลางตัวอักษร UTF-8)
fn truncate_chars(s: &str, max_chars: usize) -> (&str, bool) {
    match s.char_indices().nth(max_chars) {
        Some((i, _)) => (&s[..i], true),
        None => (s, false),
    }
}

/// อ่านไฟล์เป็นช่วงบรรทัดแบบสตรีม (ไฟล์ใหญ่ไม่ถูกโหลดเข้าหน่วยความจำทั้งก้อน)
/// หยุดเก็บเมื่อครบ limit บรรทัดหรือเกิน max_chars แต่ยังนับบรรทัดทั้งหมดต่อเพื่อบอกโมเดลว่ามีอีกเท่าไร
fn read_lines_from(
    path: &Path,
    offset: usize,
    limit: usize,
    max_chars: usize,
) -> Result<FileSlice, String> {
    use std::io::BufRead;
    let file = fs::File::open(path).map_err(|e| format!("ไม่สามารถอ่านไฟล์ {}: {}", path.display(), e))?;
    let mut reader = std::io::BufReader::new(file);

    // ไฟล์ไบนารีมักมี NUL ในช่วงต้นไฟล์
    let head = reader.fill_buf().map_err(|e| format!("อ่านไฟล์ไม่สำเร็จ: {}", e))?;
    if head.iter().take(8192).any(|b| *b == 0) {
        return Err(format!("ไฟล์ {} เป็นไฟล์ไบนารี อ่านเป็นข้อความไม่ได้", path.display()));
    }

    let start = offset.max(1);
    let mut content = String::new();
    let mut end_line = 0usize;
    let mut total = 0usize;
    let mut truncated_lines = 0usize;
    let mut collecting = true;
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = reader
            .read_until(b'\n', &mut buf)
            .map_err(|e| format!("อ่านไฟล์ไม่สำเร็จ: {}", e))?;
        if n == 0 {
            break;
        }
        total += 1;
        if !collecting || total < start {
            continue;
        }
        let text = String::from_utf8_lossy(&buf);
        let line = text.trim_end_matches(['\n', '\r']);
        let (shown, cut) = truncate_chars(line, MAX_LINE_CHARS);
        let entry = format!("{:>6}\t{}{}\n", total, shown, if cut { " …[line truncated]" } else { "" });
        // บรรทัดแรกของช่วงต้องได้เสมอ ไม่งั้นบรรทัดยาวมากบรรทัดเดียวจะทำให้อ่านต่อไม่ได้
        if end_line != 0 && content.len() + entry.len() > max_chars {
            collecting = false;
            continue;
        }
        if cut {
            truncated_lines += 1;
        }
        content.push_str(&entry);
        end_line = total;
        if end_line - start + 1 >= limit {
            collecting = false;
        }
    }
    Ok(FileSlice {
        content,
        start_line: start,
        end_line,
        total_lines: total,
        truncated_lines,
    })
}

// 4.1 อ่านไฟล์เป็นช่วงบรรทัดพร้อมเลขบรรทัด (tool read_file ของ agent)
#[tauri::command]
fn read_file_lines(
    path: String,
    workspace: Option<String>,
    allow_sensitive: Option<bool>,
    offset: Option<usize>,
    limit: Option<usize>,
    max_chars: Option<usize>,
) -> Result<FileSlice, String> {
    let valid_path = validate_workspace_path(&path, workspace.as_deref())?;
    ensure_not_sensitive(&valid_path, allow_sensitive)?;
    if valid_path.is_dir() {
        return Err(format!("{} เป็นโฟลเดอร์ ใช้ list_directory แทน", valid_path.display()));
    }
    read_lines_from(
        &valid_path,
        offset.unwrap_or(1),
        limit.unwrap_or(2000).max(1),
        max_chars.unwrap_or(40_000).max(1000),
    )
}

// 5. เขียนหรือบันทึกไฟล์ พร้อมระบบ Workspace Sandboxing
#[tauri::command]
fn write_file(
    path: String,
    content: String,
    workspace: Option<String>,
    allow_sensitive: Option<bool>,
) -> Result<String, String> {
    let valid_path = validate_workspace_path(&path, workspace.as_deref())?;
    ensure_not_sensitive(&valid_path, allow_sensitive)?;
    if let Some(parent) = valid_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("สร้างโฟลเดอร์ไม่สำเร็จ: {}", e))?;
        }
    }
    write_atomic(&valid_path, content.as_bytes()).map_err(|e| format!("เขียนไฟล์ไม่สำเร็จ: {}", e))?;
    Ok(format!("บันทึกไฟล์ {} สำเร็จ", valid_path.display()))
}

// 5.1 ไฟล์ไบนารี (.docx) — ส่งเป็น base64 เพราะ read_file/write_file รับเฉพาะข้อความ
const MAX_BINARY_FILE_BYTES: u64 = 30 * 1024 * 1024;

#[derive(Serialize)]
pub struct BinaryWriteResult {
    pub message: String,
    /// สำเนาของไฟล์เดิมก่อนเขียนทับ (ถ้าขอไว้และมีไฟล์เดิม)
    pub backup: Option<String>,
}

/// `รายงาน.docx` → `รายงาน.dex-backup.docx` (เปิดใน Word ได้เลย)
fn backup_path(path: &Path) -> PathBuf {
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let name = match path.extension() {
        Some(ext) => format!("{}.dex-backup.{}", stem, ext.to_string_lossy()),
        None => format!("{}.dex-backup", stem),
    };
    path.with_file_name(name)
}

#[tauri::command]
fn read_binary_file(path: String, workspace: Option<String>, allow_sensitive: Option<bool>) -> Result<String, String> {
    use base64::Engine;
    let valid_path = validate_workspace_path(&path, workspace.as_deref())?;
    ensure_not_sensitive(&valid_path, allow_sensitive)?;
    let meta = fs::metadata(&valid_path).map_err(|e| format!("ไม่สามารถอ่านไฟล์ {}: {}", valid_path.display(), e))?;
    if meta.len() > MAX_BINARY_FILE_BYTES {
        return Err(format!("ไฟล์ใหญ่เกิน {} MB", MAX_BINARY_FILE_BYTES / 1024 / 1024));
    }
    let bytes = fs::read(&valid_path).map_err(|e| format!("ไม่สามารถอ่านไฟล์ {}: {}", valid_path.display(), e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
fn write_binary_file(
    path: String,
    data: String,
    workspace: Option<String>,
    allow_sensitive: Option<bool>,
    backup: Option<bool>,
) -> Result<BinaryWriteResult, String> {
    use base64::Engine;
    let valid_path = validate_workspace_path(&path, workspace.as_deref())?;
    ensure_not_sensitive(&valid_path, allow_sensitive)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("ข้อมูล base64 ไม่ถูกต้อง: {}", e))?;
    if let Some(parent) = valid_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("สร้างโฟลเดอร์ไม่สำเร็จ: {}", e))?;
        }
    }
    let mut saved_backup = None;
    if backup.unwrap_or(false) && valid_path.is_file() {
        let target = backup_path(&valid_path);
        fs::copy(&valid_path, &target).map_err(|e| format!("สำรองไฟล์เดิมไม่สำเร็จ: {}", e))?;
        saved_backup = Some(target.to_string_lossy().to_string());
    }
    write_atomic(&valid_path, &bytes)
        .map_err(|e| format!("เขียนไฟล์ไม่สำเร็จ (ไฟล์อาจเปิดอยู่ในโปรแกรมอื่น): {}", e))?;
    Ok(BinaryWriteResult { message: format!("บันทึกไฟล์ {} สำเร็จ", valid_path.display()), backup: saved_backup })
}

// 6. ดูรายชื่อไฟล์ในโฟลเดอร์ พร้อมระบบ Workspace Sandboxing
#[tauri::command]
fn list_dir(path: String, workspace: Option<String>) -> Result<Vec<FileEntry>, String> {
    let valid_path = validate_workspace_path(&path, workspace.as_deref())?;
    if !valid_path.exists() {
        return Err(format!("ไม่พบโฟลเดอร์: {}", valid_path.display()));
    }
    let entries = fs::read_dir(&valid_path).map_err(|e| format!("ไม่สามารถอ่านไดเรกทอรี: {}", e))?;

    let mut results = Vec::new();
    for entry in entries.flatten() {
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        // ข้าม git, node_modules, target, dist เพื่อความเร็ว
        if name == ".git" || name == "node_modules" || name == "target" || name == "dist" {
            continue;
        }
        let metadata = entry.metadata().ok();
        let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);

        results.push(FileEntry {
            name,
            path: entry_path.to_string_lossy().to_string(),
            is_dir,
            size,
        });
    }

    results.sort_by(|a, b| {
        if a.is_dir == b.is_dir {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        } else if a.is_dir {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });

    Ok(results)
}

#[derive(Serialize, Deserialize)]
pub struct ReplaceResult {
    pub success: bool,
    pub message: String,
    pub occurrences: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct EditOp {
    pub target_content: String,
    pub replacement_content: String,
    /// true = แทนที่ทุกตำแหน่ง, false = target ต้องมีตำแหน่งเดียว
    #[serde(default)]
    pub replace_all: bool,
}

/// ใช้ edit ทีละตัวตามลำดับบนข้อความที่แปลงเป็น LF แล้ว — ผิดตัวไหนก็ไม่เขียนอะไรเลย (all-or-nothing)
/// คืนข้อความใหม่ (คง CRLF ถ้าไฟล์เดิมใช้ CRLF) และจำนวนตำแหน่งที่แทนที่ทั้งหมด
fn apply_edits(file_text: &str, edits: &[EditOp]) -> Result<(String, usize), String> {
    if edits.is_empty() {
        return Err("ต้องมี edit อย่างน้อย 1 รายการ".to_string());
    }
    let crlf = file_text.contains("\r\n");
    let mut text = file_text.replace("\r\n", "\n");
    let mut total = 0usize;
    for (i, edit) in edits.iter().enumerate() {
        // บอกลำดับ edit เฉพาะตอนแก้หลายจุด
        let label = if edits.len() > 1 { format!("edit #{}: ", i + 1) } else { String::new() };
        let target = edit.target_content.replace("\r\n", "\n");
        if target.is_empty() {
            return Err(format!("{}target_content ต้องไม่เป็นค่าว่าง", label));
        }
        let replacement = edit.replacement_content.replace("\r\n", "\n");
        let count = text.matches(&target).count();
        if count == 0 {
            return Err(format!(
                "{}ไม่พบ target_content ในไฟล์ (ต้องตรงทุกตัวอักษรรวมช่องว่าง และไม่รวมเลขบรรทัดจาก read_file)",
                label
            ));
        }
        if count > 1 && !edit.replace_all {
            return Err(format!(
                "{}พบ target_content ซ้ำกัน {} จุด กรุณาใส่บริบทรอบข้างเพิ่มให้ไม่ซ้ำ หรือใช้ replace_all",
                label, count
            ));
        }
        text = if edit.replace_all { text.replace(&target, &replacement) } else { text.replacen(&target, &replacement, 1) };
        total += count;
    }
    if crlf {
        text = text.replace('\n', "\r\n");
    }
    Ok((text, total))
}

// 6.1 แก้ไฟล์เฉพาะจุด (หนึ่งหรือหลาย edit ในครั้งเดียว แบบ atomic)
#[tauri::command]
fn edit_file(
    path: String,
    edits: Vec<EditOp>,
    workspace: Option<String>,
    allow_sensitive: Option<bool>,
) -> Result<ReplaceResult, String> {
    let valid_path = validate_workspace_path(&path, workspace.as_deref())?;
    ensure_not_sensitive(&valid_path, allow_sensitive)?;
    if !valid_path.exists() {
        return Err(format!("ไม่พบไฟล์: {}", valid_path.display()));
    }
    let file_text = fs::read_to_string(&valid_path)
        .map_err(|e| format!("ไม่สามารถอ่านไฟล์ {}: {}", valid_path.display(), e))?;
    let (new_text, occurrences) = apply_edits(&file_text, &edits)?;
    write_atomic(&valid_path, new_text.as_bytes()).map_err(|e| format!("เขียนไฟล์ไม่สำเร็จ: {}", e))?;
    Ok(ReplaceResult {
        success: true,
        message: format!(
            "แก้ {} สำเร็จ ({} edit, {} ตำแหน่ง)",
            valid_path.display(),
            edits.len(),
            occurrences
        ),
        occurrences,
    })
}

const MAX_SNAPSHOT_BYTES: u64 = 5 * 1024 * 1024;

// 6.1.1 จำเนื้อหาไฟล์ก่อน agent แก้ (checkpoint) — None = ไฟล์ยังไม่มี (undo = ลบทิ้ง)
#[tauri::command]
fn snapshot_file(
    path: String,
    workspace: Option<String>,
    allow_sensitive: Option<bool>,
) -> Result<Option<String>, String> {
    let valid_path = validate_workspace_path(&path, workspace.as_deref())?;
    ensure_not_sensitive(&valid_path, allow_sensitive)?;
    if !valid_path.exists() {
        return Ok(None);
    }
    let meta = fs::metadata(&valid_path).map_err(|e| format!("อ่านข้อมูลไฟล์ไม่สำเร็จ: {}", e))?;
    if !meta.is_file() {
        return Err(format!("ไม่ใช่ไฟล์: {}", valid_path.display()));
    }
    if meta.len() > MAX_SNAPSHOT_BYTES {
        return Err("ไฟล์ใหญ่เกินกว่าจะเก็บ checkpoint".to_string());
    }
    let bytes = fs::read(&valid_path).map_err(|e| format!("อ่านไฟล์ไม่สำเร็จ: {}", e))?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "ไฟล์ไม่ใช่ข้อความ UTF-8 จึงเก็บ checkpoint ไม่ได้".to_string())
}

// 6.1.2 ย้อนไฟล์กลับไปตาม checkpoint — content = None หมายถึงไฟล์นี้ agent สร้างใหม่ จึงลบทิ้ง
#[tauri::command]
fn restore_file(path: String, content: Option<String>, workspace: Option<String>) -> Result<String, String> {
    let valid_path = validate_workspace_path(&path, workspace.as_deref())?;
    match content {
        Some(text) => {
            if let Some(parent) = valid_path.parent() {
                if !parent.exists() {
                    fs::create_dir_all(parent).map_err(|e| format!("สร้างโฟลเดอร์ไม่สำเร็จ: {}", e))?;
                }
            }
            write_atomic(&valid_path, text.as_bytes()).map_err(|e| format!("เขียนไฟล์ไม่สำเร็จ: {}", e))?;
            Ok(format!("ย้อนไฟล์ {} แล้ว", valid_path.display()))
        }
        None => {
            if valid_path.is_file() {
                fs::remove_file(&valid_path).map_err(|e| format!("ลบไฟล์ไม่สำเร็จ: {}", e))?;
            }
            Ok(format!("ลบไฟล์ {} ที่ agent สร้างแล้ว", valid_path.display()))
        }
    }
}

// 6.1.3 Snapshot ทั้ง workspace ด้วย git (สำหรับย้อนไฟล์ที่คำสั่ง shell แก้)
// ใช้ index ชั่วคราว (GIT_INDEX_FILE) จึงไม่แตะ index/stash/branch ของผู้ใช้เลย — ได้แค่ object ที่ไม่มีใครอ้างถึง
// (git gc เก็บกวาดเอง) ครอบคลุมไฟล์ที่ track และ untracked ทั้งหมด ยกเว้นไฟล์ใน .gitignore

fn git_command(dir: &Path, args: &[&str], index: Option<&Path>) -> Result<Vec<u8>, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args).current_dir(dir);
    if let Some(index) = index {
        cmd.env("GIT_INDEX_FILE", index);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let out = cmd.output().map_err(|e| format!("เรียก git ไม่สำเร็จ: {}", e))?;
    if !out.status.success() {
        return Err(format!("git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(out.stdout)
}

fn git_text(dir: &Path, args: &[&str], index: Option<&Path>) -> Result<String, String> {
    git_command(dir, args, index).map(|b| String::from_utf8_lossy(&b).trim_end().to_string())
}

/// tree ของสภาพ workspace ตอนนี้ (รวม untracked) — index ชั่วคราวเริ่มจากสำเนา index จริง
/// เพื่อให้ `git add` hash ใหม่เฉพาะไฟล์ที่เปลี่ยน
fn workspace_tree(ws: &Path) -> Result<String, String> {
    let real_index = PathBuf::from(git_text(ws, &["rev-parse", "--git-path", "index"], None)?);
    let real_index = if real_index.is_absolute() { real_index } else { ws.join(real_index) };
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("dex-index-{}-{}", std::process::id(), nanos));
    if real_index.exists() {
        fs::copy(&real_index, &tmp).map_err(|e| format!("คัดลอก git index ไม่สำเร็จ: {}", e))?;
    }
    let result = git_command(ws, &["add", "-A", "--", "."], Some(&tmp))
        .and_then(|_| git_text(ws, &["write-tree"], Some(&tmp)));
    let _ = fs::remove_file(&tmp);
    result
}

fn is_object_id(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// None = workspace ไม่ได้อยู่ใน git repo (หรือไม่มี git) — ย้อนไฟล์ที่ shell แก้ไม่ได้
#[tauri::command]
async fn git_snapshot(workspace: Option<String>) -> Result<Option<String>, String> {
    let ws = resolve_workspace_root(workspace.as_deref());
    tokio::task::spawn_blocking(move || {
        if git_text(&ws, &["rev-parse", "--is-inside-work-tree"], None).ok().as_deref() != Some("true") {
            return Ok(None);
        }
        workspace_tree(&ws).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// ย้อนไฟล์ใน workspace กลับไปตาม snapshot: ไฟล์ที่เกิดใหม่หลัง snapshot ถูกลบ ไฟล์ที่ถูกแก้/ลบได้เนื้อหาเดิม
/// (ผ่าน filter ของ repo เช่น autocrlf) คืนรายการพาธที่เปลี่ยน (สัมพัทธ์กับ workspace)
#[tauri::command]
async fn git_restore_snapshot(workspace: Option<String>, tree: String) -> Result<Vec<String>, String> {
    if !is_object_id(&tree) {
        return Err("snapshot ไม่ถูกต้อง".to_string());
    }
    let ws = resolve_workspace_root(workspace.as_deref());
    tokio::task::spawn_blocking(move || restore_snapshot(&ws, &tree)).await.map_err(|e| e.to_string())?
}

fn restore_snapshot(ws: &Path, tree: &str) -> Result<Vec<String>, String> {
    let current = workspace_tree(ws)?;
    if current == tree {
        return Ok(Vec::new());
    }
    let prefix = git_text(ws, &["rev-parse", "--show-prefix"], None)?;
    // --relative: เฉพาะไฟล์ใต้ workspace และพาธสัมพัทธ์กับ workspace
    let diff = git_command(ws, &["diff-tree", "-r", "-z", "--no-renames", "--name-status", "--relative", tree, &current], None)?;
    let fields: Vec<String> = diff
        .split(|b| *b == 0)
        .filter(|f| !f.is_empty())
        .map(|f| String::from_utf8_lossy(f).to_string())
        .collect();

    let mut changed = Vec::new();
    for pair in fields.chunks(2) {
        let [status, rel] = pair else { continue };
        let target = lexical_normalize(&ws.join(rel));
        if !is_within(&target, ws) {
            continue;
        }
        if status.starts_with('A') {
            // เกิดใหม่หลัง snapshot
            if target.is_file() {
                fs::remove_file(&target).map_err(|e| format!("ลบ {} ไม่สำเร็จ: {}", rel, e))?;
                // โฟลเดอร์ที่ว่างลงเพราะการลบนี้ก็เกิดใหม่หลัง snapshot เหมือนกัน (remove_dir ลบได้เฉพาะโฟลเดอร์ว่าง)
                let mut dir = target.parent().map(Path::to_path_buf);
                while let Some(d) = dir.filter(|d| is_within(d, ws) && d.as_path() != ws) {
                    if fs::remove_dir(&d).is_err() {
                        break;
                    }
                    dir = d.parent().map(Path::to_path_buf);
                }
            }
        } else {
            let spec = format!("{}:{}{}", tree, prefix, rel);
            let bytes = git_command(ws, &["cat-file", "--filters", &spec], None)?;
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("สร้างโฟลเดอร์ไม่สำเร็จ: {}", e))?;
            }
            write_atomic(&target, &bytes).map_err(|e| format!("เขียน {} ไม่สำเร็จ: {}", rel, e))?;
        }
        changed.push(rel.clone());
    }
    Ok(changed)
}

#[derive(Serialize, Deserialize)]
pub struct GrepMatch {
    pub file: String,
    pub line_number: usize,
    pub line_content: String,
}

const SKIP_DIRS: [&str; 6] = [".git", "node_modules", "target", "dist", "build", ".next"];
const MAX_SEARCH_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_VISITED_ENTRIES: usize = 50_000;

/// เดินไดเรกทอรีแบบ iterative ภายใน workspace โดยไม่ตาม symlink/junction (กันวนลูปไม่จบ)
/// และข้ามโฟลเดอร์ build/dependency ที่ใหญ่ เรียง path ให้ผลลัพธ์คงที่
fn walk_workspace<F: FnMut(&Path, &str) -> bool>(root: &Path, mut on_file: F) {
    let mut stack = vec![root.to_path_buf()];
    let mut visited = 0usize;
    while let Some(dir) = stack.pop() {
        let mut entries: Vec<_> = match fs::read_dir(&dir) {
            Ok(rd) => rd.flatten().collect(),
            Err(_) => continue,
        };
        entries.sort_by_key(|e| e.file_name());
        let mut subdirs = Vec::new();
        for entry in entries {
            visited += 1;
            if visited > MAX_VISITED_ENTRIES {
                return;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // file_type() ไม่ตาม symlink
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    subdirs.push(entry.path());
                }
            } else if ft.is_file() {
                let path = entry.path();
                let rel = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                if !on_file(&path, &rel) {
                    return;
                }
            }
        }
        // push กลับด้านเพื่อให้ pop ได้ตามลำดับตัวอักษร
        stack.extend(subdirs.into_iter().rev());
    }
}

fn has_glob_chars(p: &str) -> bool {
    p.contains(['*', '?', '[', '{'])
}

/// glob ที่ไม่มี `/` (เช่น `*.ts`) เทียบกับชื่อไฟล์ในทุกระดับ ส่วนที่มี `/` เทียบกับพาธเต็มใน workspace
fn build_glob(pattern: &str) -> Result<globset::GlobMatcher, String> {
    let p = pattern.trim().replace('\\', "/");
    let p = p.trim_start_matches("./");
    let full = if p.contains('/') || p.starts_with("**") { p.to_string() } else { format!("**/{}", p) };
    globset::GlobBuilder::new(&full)
        .case_insensitive(true)
        .literal_separator(true)
        .build()
        .map(|g| g.compile_matcher())
        .map_err(|e| format!("glob ไม่ถูกต้อง '{}': {}", pattern, e))
}

/// ตัวเทียบบรรทัดของ grep: regex จริง หรือ substring ที่ escape แล้ว (ใช้ engine เดียวกัน)
fn build_line_matcher(query: &str, is_regex: bool, case_insensitive: bool) -> Result<regex::Regex, String> {
    let pattern = if is_regex { query.to_string() } else { regex::escape(query) };
    regex::RegexBuilder::new(&pattern)
        .case_insensitive(case_insensitive)
        .size_limit(1 << 20)
        .build()
        .map_err(|e| format!("regex ไม่ถูกต้อง: {}", e))
}

// 6.2 ค้นหาข้อความหรือโค้ดข้ามทั้งโปรเจกต์ (substring หรือ regex, กรองไฟล์ด้วย glob ได้)
// รันใน blocking thread pool เพื่อไม่ให้หน้าต่างค้างระหว่างสแกน
#[tauri::command]
async fn grep_search(
    query: String,
    case_insensitive: Option<bool>,
    max_results: Option<usize>,
    workspace: Option<String>,
    regex: Option<bool>,
    include: Option<String>,
) -> Result<Vec<GrepMatch>, String> {
    if query.is_empty() {
        return Err("query ต้องไม่เป็นค่าว่าง".to_string());
    }
    let root = resolve_workspace_root(workspace.as_deref());
    let matcher = build_line_matcher(&query, regex.unwrap_or(false), case_insensitive.unwrap_or(true))?;
    let include = match include.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(g) => Some(build_glob(g)?),
        None => None,
    };
    tokio::task::spawn_blocking(move || {
        let limit = max_results.unwrap_or(50).clamp(1, 500);
        let mut matches = Vec::new();

        walk_workspace(&root, |path, rel| {
            // ไม่ค้นในไฟล์ลับ — ไม่งั้นค้นคำว่า "KEY" ก็ได้ API key ออกไปทั้งบรรทัด
            if is_sensitive_path(Path::new(rel)) {
                return true;
            }
            if include.as_ref().map(|g| !g.is_match(rel)).unwrap_or(false) {
                return true;
            }
            let too_big = fs::metadata(path).map(|m| m.len() > MAX_SEARCH_FILE_BYTES).unwrap_or(true);
            if too_big {
                return true;
            }
            // read_to_string ล้มเหลวกับไฟล์ไบนารี/ไม่ใช่ UTF-8 → ข้าม
            if let Ok(content) = fs::read_to_string(path) {
                for (idx, line) in content.lines().enumerate() {
                    if matcher.is_match(line) {
                        let mut text = line.trim_end().to_string();
                        if text.len() > 400 {
                            let cut = (0..=400).rev().find(|i| text.is_char_boundary(*i)).unwrap_or(0);
                            text.truncate(cut);
                            text.push('…');
                        }
                        matches.push(GrepMatch {
                            file: rel.to_string(),
                            line_number: idx + 1,
                            line_content: text,
                        });
                        if matches.len() >= limit {
                            return false;
                        }
                    }
                }
            }
            true
        });
        Ok(matches)
    })
    .await
    .map_err(|e| format!("grep_search ล้มเหลว: {}", e))?
}

// 6.3 ค้นหาไฟล์ด้วย glob (`*.tsx`, `src/**/*.test.ts`) หรือ substring ของ path (`Header`)
#[tauri::command]
async fn find_files(pattern: String, workspace: Option<String>) -> Result<Vec<String>, String> {
    let root = resolve_workspace_root(workspace.as_deref());
    let pat = pattern.trim().to_lowercase().replace('\\', "/");
    let glob = if has_glob_chars(&pat) && pat != "*" { Some(build_glob(&pat)?) } else { None };
    tokio::task::spawn_blocking(move || {
        let needle = pat.replace('*', "");
        let mut results = Vec::new();

        walk_workspace(&root, |_, rel| {
            let matched = match &glob {
                Some(g) => g.is_match(rel),
                None => needle.is_empty() || rel.to_lowercase().contains(&needle),
            };
            if matched {
                results.push(rel.to_string());
            }
            results.len() < 200
        });
        Ok(results)
    })
    .await
    .map_err(|e| format!("find_files ล้มเหลว: {}", e))?
}

// 7. ดึงค่าเริ่มต้นของ CWD และ API Keys จาก .env ครบทุกค่าย
#[tauri::command]
fn get_initial_env() -> Result<serde_json::Value, String> {
    let current_dir = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string());

    let env_key_map: [(&str, &str); 14] = [
        ("GOOGLE_GENERATIVE_AI_API_KEY", "google"),
        ("GOOGLE_API_KEY", "google"),
        ("GEMINI_API_KEY", "google"),
        ("ANTHROPIC_API_KEY", "anthropic"),
        ("OPENAI_API_KEY", "openai"),
        ("XAI_API_KEY", "xai"),
        ("DEEPSEEK_API_KEY", "deepseek"),
        ("DASHSCOPE_API_KEY", "qwen"),
        ("QWEN_API_KEY", "qwen"),
        ("MOONSHOT_API_KEY", "moonshot"),
        ("SILICONFLOW_API_KEY", "siliconflow"),
        ("OPENROUTER_API_KEY", "openrouter"),
        ("GROQ_API_KEY", "groq"),
        ("CUSTOM_API_KEY", "custom"),
    ];

    let mut discovered_keys = serde_json::Map::new();
    let env_path = Path::new(&current_dir).join(".env");
    if let Ok(content) = fs::read_to_string(&env_path) {
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if let Some((key, val)) = trimmed.split_once('=') {
                let k = key.trim().trim_start_matches("export ").trim();
                let v = val.trim().trim_matches('"').trim_matches('\'');
                if v.is_empty() {
                    continue;
                }
                if let Some((_, provider)) = env_key_map.iter().find(|(name, _)| *name == k) {
                    discovered_keys
                        .entry(provider.to_string())
                        .or_insert_with(|| serde_json::json!(v));
                }
            }
        }
    }

    Ok(serde_json::json!({
        "cwd": current_dir,
        "apiKey": discovered_keys.get("google").and_then(|v| v.as_str()).unwrap_or(""),
        "keys": discovered_keys,
        "platform": std::env::consts::OS,
    }))
}

// 7.0 Skills: โฟลเดอร์ที่มี SKILL.md (frontmatter name/description + คำสั่ง) แบบเดียวกับ Agent Skills
// ค้นใน workspace (.dex/skills, .claude/skills) และของผู้ใช้ (~/.dex/skills) — ของ workspace ชนะถ้าชื่อซ้ำ

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    /// โฟลเดอร์ของ skill (ใช้กับ read_skill_file)
    pub dir: String,
    /// "workspace" | "user"
    pub source: String,
    /// ติดตั้งจาก Marketplace (ถอนการติดตั้งได้) — skill ที่ผู้ใช้เขียนเองเป็น false
    pub managed: bool,
}

const MAX_SKILL_FILE_BYTES: u64 = 256 * 1024;
/// ไฟล์ว่างในโฟลเดอร์ skill ที่ Marketplace สร้าง — ไม่มีไฟล์นี้ = ของผู้ใช้ ห้ามเขียนทับหรือลบ
const MANAGED_SKILL_MARKER: &str = ".dex-plugin";

fn user_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

fn skill_roots(workspace: Option<&str>) -> Vec<(PathBuf, &'static str)> {
    let mut roots = Vec::new();
    if let Some(ws) = workspace.map(str::trim).filter(|w| !w.is_empty()) {
        let ws = PathBuf::from(ws);
        roots.push((ws.join(".dex").join("skills"), "workspace"));
        roots.push((ws.join(".claude").join("skills"), "workspace"));
    }
    if let Some(home) = user_home() {
        roots.push((home.join(".dex").join("skills"), "user"));
    }
    roots
}

/// อ่าน frontmatter แบบ YAML อย่างง่าย: `key: value` บรรทัดเดียว (มี/ไม่มี quote) และ `key: >` / `key: |`
/// ที่ตามด้วยบรรทัดเยื้อง — พอสำหรับ name/description ของ SKILL.md
fn parse_frontmatter(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let body = text.trim_start_matches('\u{feff}');
    let mut lines = body.lines();
    if lines.next().map(str::trim) != Some("---") {
        return out;
    }
    let mut current: Option<(String, Vec<String>)> = None;
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if indented {
            if let Some((_, parts)) = current.as_mut() {
                parts.push(line.trim().to_string());
            }
            continue;
        }
        if let Some((key, parts)) = current.take() {
            out.insert(key, parts.join(" ").trim().to_string());
        }
        if let Some((key, value)) = line.split_once(':') {
            let value = value.trim();
            let value = if value == ">" || value == "|" || value == ">-" || value == "|-" { "" } else { value };
            let value = value.trim_matches(|c| c == '"' || c == '\'');
            current = Some((key.trim().to_lowercase(), vec![value.to_string()]));
        }
    }
    if let Some((key, parts)) = current {
        out.insert(key, parts.join(" ").trim().to_string());
    }
    out
}

fn find_skill_file(dir: &Path) -> Option<PathBuf> {
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case("skill.md") && e.path().is_file())
        .map(|e| e.path())
}

fn scan_skills(roots: &[(PathBuf, &'static str)]) -> Vec<SkillInfo> {
    let mut seen = HashSet::new();
    let mut skills = Vec::new();
    for (root, source) in roots {
        let Ok(entries) = fs::read_dir(root) else { continue };
        let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        for dir in dirs {
            let Some(file) = find_skill_file(&dir) else { continue };
            if fs::metadata(&file).map(|m| m.len() > MAX_SKILL_FILE_BYTES).unwrap_or(true) {
                continue;
            }
            let Ok(text) = fs::read_to_string(&file) else { continue };
            let meta = parse_frontmatter(&text);
            let dir_name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let name = meta.get("name").filter(|n| !n.is_empty()).cloned().unwrap_or(dir_name);
            let description = meta.get("description").cloned().unwrap_or_default();
            if !valid_provider_id(&name) || description.is_empty() || !seen.insert(name.to_lowercase()) {
                continue;
            }
            skills.push(SkillInfo {
                name,
                description,
                dir: dir.to_string_lossy().to_string(),
                source: source.to_string(),
                managed: *source == "user" && dir.join(MANAGED_SKILL_MARKER).is_file(),
            });
        }
    }
    skills
}

#[tauri::command]
fn list_skills(workspace: Option<String>) -> Vec<SkillInfo> {
    scan_skills(&skill_roots(workspace.as_deref()))
}

/// เขียน skill จาก Marketplace ลง `<root>/<name>/` — ไม่เขียนทับโฟลเดอร์ที่ผู้ใช้สร้างเอง
fn install_skill_in(root: &Path, name: &str, content: &str) -> Result<PathBuf, String> {
    if !valid_provider_id(name) {
        return Err(format!("ชื่อ skill ไม่ถูกต้อง: {}", name));
    }
    if content.len() as u64 > MAX_SKILL_FILE_BYTES {
        return Err("skill ใหญ่เกินไป".to_string());
    }
    let dir = root.join(name);
    if dir.exists() && !dir.join(MANAGED_SKILL_MARKER).is_file() {
        return Err(format!("มี skill ชื่อ {} ของคุณอยู่แล้วที่ {} — ไม่เขียนทับ", name, dir.display()));
    }
    fs::create_dir_all(&dir).map_err(|e| format!("สร้างโฟลเดอร์ skill ไม่สำเร็จ: {}", e))?;
    fs::write(dir.join(MANAGED_SKILL_MARKER), "").map_err(|e| format!("ติดตั้ง skill ไม่สำเร็จ: {}", e))?;
    fs::write(dir.join("SKILL.md"), content).map_err(|e| format!("ติดตั้ง skill ไม่สำเร็จ: {}", e))?;
    Ok(dir)
}

/// ลบเฉพาะ skill ที่ Marketplace ติดตั้ง (โฟลเดอร์จริงที่มี marker) — ไม่มีอยู่แล้วถือว่าสำเร็จ
fn uninstall_skill_in(root: &Path, name: &str) -> Result<(), String> {
    if !valid_provider_id(name) {
        return Err(format!("ชื่อ skill ไม่ถูกต้อง: {}", name));
    }
    let dir = root.join(name);
    let meta = match fs::symlink_metadata(&dir) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("อ่านโฟลเดอร์ skill ไม่สำเร็จ: {}", e)),
    };
    if !meta.is_dir() || !dir.join(MANAGED_SKILL_MARKER).is_file() {
        return Err(format!("{} ไม่ได้ติดตั้งจาก Marketplace จึงไม่ลบให้ — ลบโฟลเดอร์เองถ้าต้องการ", dir.display()));
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("ลบ skill ไม่สำเร็จ: {}", e))
}

fn user_skill_root() -> Result<PathBuf, String> {
    user_home()
        .map(|home| home.join(".dex").join("skills"))
        .ok_or_else(|| "หาโฟลเดอร์ผู้ใช้ไม่พบ".to_string())
}

#[tauri::command]
fn install_user_skill(name: String, content: String) -> Result<String, String> {
    install_skill_in(&user_skill_root()?, &name, &content).map(|dir| dir.to_string_lossy().to_string())
}

#[tauri::command]
fn uninstall_user_skill(name: String) -> Result<(), String> {
    uninstall_skill_in(&user_skill_root()?, &name)
}

/// อ่านไฟล์ในโฟลเดอร์ของ skill (ค่าเริ่มต้น SKILL.md) — โฟลเดอร์ต้องอยู่ใต้ skill root จริง
/// และไฟล์ต้องอยู่ในโฟลเดอร์นั้น (skill ของผู้ใช้อยู่นอก workspace จึงมี sandbox ของตัวเอง)
#[tauri::command]
fn read_skill_file(dir: String, file: Option<String>, workspace: Option<String>) -> Result<String, String> {
    let dir_path = fs::canonicalize(&dir).map_err(|e| format!("ไม่พบโฟลเดอร์ skill {}: {}", dir, e))?;
    let under_root = skill_roots(workspace.as_deref()).iter().any(|(root, _)| {
        fs::canonicalize(root).map(|r| is_within(&dir_path, &r) && dir_path != r).unwrap_or(false)
    });
    if !under_root {
        return Err(format!("ความปลอดภัย: {} ไม่ใช่โฟลเดอร์ skill", dir));
    }
    let target = match file.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
        Some(f) => validate_workspace_path(f, Some(&dir_path.to_string_lossy()))?,
        None => find_skill_file(&dir_path).ok_or("ไม่พบ SKILL.md")?,
    };
    ensure_not_sensitive(&target, None)?;
    if fs::metadata(&target).map(|m| m.len() > MAX_SKILL_FILE_BYTES).unwrap_or(true) {
        return Err("ไฟล์ใหญ่เกินไปหรือไม่มีอยู่".to_string());
    }
    fs::read_to_string(&target).map_err(|e| format!("อ่านไฟล์ไม่สำเร็จ: {}", e))
}

// 7.0.1 MCP (Model Context Protocol) — Rust ทำแค่ transport ส่วน JSON-RPC/โปรโตคอลอยู่ฝั่ง TypeScript
// stdio: spawn server แล้วส่ง/รับข้อความทีละบรรทัด (newline-delimited JSON) ผ่าน event `mcp-message`
// http: POST ผ่าน Rust เพราะ fetch ของ webview ติด CORS กับ server ส่วนใหญ่

/// คีย์ของ plugin อยู่ใน Credential Manager ชื่อ `mcp-secret-<NAME>` — แยก namespace จาก API key ของค่าย AI
/// config ที่อ้าง `${anthropic}` จึงอ่าน API key ของแอปไม่ได้
const MCP_SECRET_PREFIX: &str = "mcp-secret-";

/// ค่าของ `${NAME}`: ที่ผู้ใช้กรอกในหน้า Customizations ก่อน แล้วค่อย environment variable
fn lookup_secret(name: &str) -> Option<String> {
    keyring_entry(&format!("{}{}", MCP_SECRET_PREFIX, name))
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .or_else(|| std::env::var(name).ok())
        .filter(|value| !value.is_empty())
}

/// บอกแค่ว่ามีค่าหรือไม่ — ไม่ส่งค่าจริงกลับไปที่ webview
#[tauri::command]
fn mcp_secrets_present(names: Vec<String>) -> HashMap<String, bool> {
    names
        .into_iter()
        .map(|name| {
            let present = lookup_secret(&name).is_some();
            (name, present)
        })
        .collect()
}

/// แทน `${NAME}` ด้วยคีย์ใน Credential Manager หรือ environment variable — ไม่ต้องพิมพ์ token ลง settings
fn expand_env(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        match rest[start + 2..].find('}') {
            Some(end) => {
                let name = &rest[start + 2..start + 2 + end];
                out.push_str(&lookup_secret(name).unwrap_or_default());
                rest = &rest[start + 3 + end..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

#[derive(Serialize, Clone)]
struct McpEvent {
    id: String,
    /// mcp-message: ข้อความ JSON-RPC หนึ่งบรรทัด, mcp-stderr: log หนึ่งบรรทัด, mcp-exit: exit code
    text: String,
}

/// Windows: `npx`/`uvx` จริง ๆ คือ npx.cmd/uvx.exe — Command::new ไม่เติมนามสกุลให้ (ยกเว้น .exe) จึงลองเอง
fn spawn_mcp(command: &str, args: &[String], env: &HashMap<String, String>, cwd: Option<&str>) -> std::io::Result<tokio::process::Child> {
    let attempt = |program: &str| {
        let mut cmd = Command::new(program);
        cmd.args(args.iter().map(|a| expand_env(a)))
            .envs(env.iter().map(|(k, v)| (k.clone(), expand_env(v))))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(dir) = cwd.map(str::trim).filter(|d| !d.is_empty()) {
            cmd.current_dir(dir);
        }
        #[cfg(windows)]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd.spawn()
    };
    match attempt(command) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && Path::new(command).extension().is_none() => {
            for ext in ["cmd", "exe", "bat"] {
                if let Ok(child) = attempt(&format!("{}.{}", command, ext)) {
                    return Ok(child);
                }
            }
            Err(e)
        }
        other => other,
    }
}

/// หาโปรแกรมใน PATH ด้วยนามสกุลเดียวกับที่ spawn_mcp ลอง — แค่ดูไฟล์ ไม่รันอะไร
fn find_on_path(program: &str, path: &std::ffi::OsStr) -> bool {
    let names: Vec<String> = if cfg!(windows) {
        ["exe", "cmd", "bat"].iter().map(|ext| format!("{}.{}", program, ext)).collect()
    } else {
        vec![program.to_string()]
    };
    std::env::split_paths(path).any(|dir| names.iter().any(|name| dir.join(name).is_file()))
}

#[tauri::command]
fn command_available(program: String) -> bool {
    // ชื่อล้วนเท่านั้น กัน `..\` ออกไปดูไฟล์นอก PATH
    valid_provider_id(&program) && std::env::var_os("PATH").is_some_and(|path| find_on_path(&program, &path))
}

#[tauri::command]
async fn mcp_start(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    cwd: Option<String>,
) -> Result<u32, String> {
    if let Some(old) = state.mcp.lock().unwrap().remove(&id) {
        kill_process_tree(old.pid);
    }
    let mut child = spawn_mcp(&command, &args, &env, cwd.as_deref())
        .map_err(|e| format!("เปิด MCP server `{}` ไม่สำเร็จ: {}", command, e))?;
    let pid = child.id().unwrap_or(0);
    let stdin = child.stdin.take().ok_or("ไม่สามารถจับ stdin ได้")?;
    let stdout = child.stdout.take().ok_or("ไม่สามารถจับ stdout ได้")?;
    let stderr = child.stderr.take().ok_or("ไม่สามารถจับ stderr ได้")?;
    state.mcp.lock().unwrap().insert(
        id.clone(),
        McpProcess { pid, stdin: Arc::new(tokio::sync::Mutex::new(stdin)) },
    );

    for (reader, event) in [
        (Box::new(stdout) as Box<dyn tokio::io::AsyncRead + Unpin + Send>, "mcp-message"),
        (Box::new(stderr), "mcp-stderr"),
    ] {
        let app = app.clone();
        let id = id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    let _ = app.emit(event, McpEvent { id: id.clone(), text: line });
                }
            }
        });
    }

    let processes = state.mcp.clone();
    tokio::spawn(async move {
        let code = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
        {
            // อาจถูก restart ไปแล้วด้วย id เดิม — ลบเฉพาะถ้ายังเป็น process นี้
            let mut map = processes.lock().unwrap();
            if map.get(&id).map(|p| p.pid == pid).unwrap_or(false) {
                map.remove(&id);
            }
        }
        let _ = app.emit("mcp-exit", McpEvent { id, text: code.to_string() });
    });
    Ok(pid)
}

#[tauri::command]
async fn mcp_send(state: State<'_, AppState>, id: String, message: String) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let stdin = state
        .mcp
        .lock()
        .unwrap()
        .get(&id)
        .map(|p| p.stdin.clone())
        .ok_or_else(|| format!("MCP server {} ไม่ได้รันอยู่", id))?;
    let mut stdin = stdin.lock().await;
    // ข้อความ stdio ต้องอยู่บรรทัดเดียว (JSON.stringify ไม่มี newline อยู่แล้ว)
    stdin.write_all(message.replace('\n', " ").as_bytes()).await.map_err(|e| e.to_string())?;
    stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())
}

#[tauri::command]
fn mcp_stop(state: State<'_, AppState>, id: String) {
    if let Some(p) = state.mcp.lock().unwrap().remove(&id) {
        kill_process_tree(p.pid);
    }
}

#[derive(Serialize)]
pub struct HttpResponse {
    pub status: u16,
    /// ชื่อ header เป็นตัวพิมพ์เล็ก
    pub headers: HashMap<String, String>,
    pub body: String,
    /// `WWW-Authenticate: Bearer ...` ของ response 401/403 ที่แยกส่วนให้แล้ว
    pub auth_challenge: Option<AuthChallenge>,
}

/// POST หนึ่งครั้งโดยใส่ access token ถ้ามี
/// มี `oauth_key` = server นี้ใช้ OAuth: ไม่ตาม redirect (กัน token หลุดไปปลายทางอื่น) และไม่ใช้ Authorization จาก config
fn mcp_http_send(
    url: &str,
    headers: &HashMap<String, String>,
    body: &str,
    timeout_ms: Option<u64>,
    uses_oauth: bool,
    bearer: Option<&str>,
) -> Result<HttpResponse, String> {
    let mut builder = ureq::AgentBuilder::new().timeout(Duration::from_millis(timeout_ms.unwrap_or(120_000).clamp(1_000, 900_000)));
    if uses_oauth {
        builder = builder.redirects(0);
    }
    let agent = builder.build();
    let mut req = agent.post(url);
    for (k, v) in headers {
        if uses_oauth && k.eq_ignore_ascii_case("authorization") {
            continue;
        }
        req = req.set(k, &expand_env(v));
    }
    if let Some(token) = bearer {
        req = req.set("Authorization", &format!("Bearer {}", token));
    }
    let resp = match req.send_string(body) {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(format!("เชื่อมต่อ MCP server ไม่สำเร็จ: {}", e)),
    };
    let status = resp.status();
    let auth_challenge = if status == 401 || status == 403 { response_challenge(&resp) } else { None };
    let mut out_headers = HashMap::new();
    for name in resp.headers_names() {
        if let Some(v) = resp.header(&name) {
            out_headers.insert(name.to_lowercase(), v.to_string());
        }
    }
    let body = resp.into_string().map_err(|e| format!("อ่าน response ไม่สำเร็จ: {}", e))?;
    Ok(HttpResponse { status, headers: out_headers, body, auth_challenge })
}

/// ใส่ token ก่อนส่ง ต่ออายุถ้าหมดอายุแล้ว และลองใหม่หนึ่งครั้งถ้า server ปฏิเสธ token ที่ยังไม่หมดอายุ
fn mcp_http_post(
    store: &dyn OauthStore,
    url: &str,
    headers: &HashMap<String, String>,
    body: &str,
    timeout_ms: Option<u64>,
    oauth_key: Option<&str>,
) -> Result<HttpResponse, String> {
    let url = expand_env(url);
    let bearer = match oauth_key {
        Some(key) => oauth_bearer(store, key, &url)?,
        None => None,
    };
    let response = mcp_http_send(&url, headers, body, timeout_ms, oauth_key.is_some(), bearer.as_deref())?;
    if let (401, Some(key), Some(rejected)) = (response.status, oauth_key, bearer.as_deref()) {
        if let Some(fresh) = oauth_bearer_after_rejection(store, key, &url, rejected)? {
            return mcp_http_send(&url, headers, body, timeout_ms, true, Some(&fresh));
        }
    }
    Ok(response)
}

/// POST หนึ่งครั้งสำหรับ MCP แบบ Streamable HTTP — คืน response ทุกสถานะ (ให้ฝั่ง TS ตัดสินเอง)
/// `oauth_key` = ชื่อ server ใน vault ของ OAuth — token ไม่เคยผ่าน webview เพราะฝั่งนี้ใส่ header เอง
#[tauri::command]
async fn mcp_http_request(
    url: String,
    headers: HashMap<String, String>,
    body: String,
    timeout_ms: Option<u64>,
    oauth_key: Option<String>,
) -> Result<HttpResponse, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("MCP URL ต้องขึ้นต้นด้วย http:// หรือ https://".to_string());
    }
    tokio::task::spawn_blocking(move || mcp_http_post(&CredentialStore, &url, &headers, &body, timeout_ms, oauth_key.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

// 7.0.2 OAuth ของ MCP แบบ remote ตาม MCP authorization spec ฉบับ 2026-07-28
// ทุกขั้นอยู่ฝั่งนี้ทั้งหมด (ค้น metadata, ลงทะเบียน client, แลก/ต่ออายุ token) เพื่อให้ webview ไม่เคยเห็น token
// และกำหนดปลายทางที่จะส่ง refresh token ไม่ได้ — webview ได้แค่ OauthStatus ที่ไม่มีความลับ
//
// ยังไม่รองรับ Client ID Metadata Document เพราะต้องมีเอกสารของ Dex บน HTTPS จึงใช้ Dynamic Client Registration

/// ชื่อใน Credential Manager มีจุดเสมอ: `mcp-oauth.<key>.<ลำดับ>` — valid_provider_id ไม่รับจุด
/// load_api_keys/save_api_key จึงอ่านหรือเขียนทับ token ไม่ได้ และ `${NAME}` ก็ไม่ถึงเพราะมี prefix mcp-secret- นำหน้า
const OAUTH_VAULT_PREFIX: &str = "mcp-oauth.";
/// Credential Manager จำกัด 2,560 ไบต์ต่อรายการ แต่ access token แบบ JWT ยาวกว่านั้นได้ จึงแบ่งเก็บหลายรายการ
const OAUTH_PART_BYTES: usize = 2048;
const OAUTH_MAX_PARTS: usize = 32;
/// ต่ออายุก่อนหมดจริงเล็กน้อย กัน token หมดระหว่างเดินทาง
const OAUTH_EXPIRY_LEEWAY_SECS: u64 = 60;
const OAUTH_LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
const OAUTH_HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const OAUTH_CALLBACK_PATH: &str = "/callback";
const OAUTH_INITIALIZE_PROBE: &str = r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"dex-agent","version":"0.1.0"}}}"#;

// รหัส error ที่ส่งให้ TS แปลเป็นข้อความสองภาษาใน i18n.ts (รูปแบบ `รหัส: รายละเอียด`)
const OAUTH_ERR_BAD_SERVER: &str = "OAUTH_BAD_SERVER";
const OAUTH_ERR_NETWORK: &str = "OAUTH_NETWORK";
const OAUTH_ERR_NO_METADATA: &str = "OAUTH_NO_METADATA";
const OAUTH_ERR_RESOURCE_MISMATCH: &str = "OAUTH_RESOURCE_MISMATCH";
const OAUTH_ERR_NO_AS_METADATA: &str = "OAUTH_NO_AS_METADATA";
const OAUTH_ERR_INSECURE_ENDPOINT: &str = "OAUTH_INSECURE_ENDPOINT";
const OAUTH_ERR_NO_PKCE: &str = "OAUTH_NO_PKCE";
const OAUTH_ERR_NO_REGISTRATION: &str = "OAUTH_NO_REGISTRATION";
const OAUTH_ERR_REGISTRATION: &str = "OAUTH_REGISTRATION_FAILED";
const OAUTH_ERR_BROWSER: &str = "OAUTH_BROWSER";
const OAUTH_ERR_LISTENER: &str = "OAUTH_LISTENER";
const OAUTH_ERR_TIMEOUT: &str = "OAUTH_TIMEOUT";
const OAUTH_ERR_CANCELLED: &str = "OAUTH_CANCELLED";
const OAUTH_ERR_ISSUER: &str = "OAUTH_ISSUER_MISMATCH";
const OAUTH_ERR_DENIED: &str = "OAUTH_DENIED";
const OAUTH_ERR_AUTHORIZATION: &str = "OAUTH_AUTHORIZATION_FAILED";
const OAUTH_ERR_TOKEN: &str = "OAUTH_TOKEN_FAILED";
const OAUTH_ERR_REFRESH: &str = "OAUTH_REFRESH_FAILED";
const OAUTH_ERR_STORE: &str = "OAUTH_STORE";

/// พารามิเตอร์ของ `WWW-Authenticate: Bearer ...` ที่ flow นี้ใช้
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct AuthChallenge {
    error: Option<String>,
    scope: Option<String>,
    resource_metadata: Option<String>,
}

/// แยกด้วยจุลภาคที่อยู่นอกเครื่องหมายคำพูด
fn split_header_items(header: &str) -> Vec<&str> {
    let mut items = Vec::new();
    let (mut start, mut quoted, mut escaped) = (0, false, false);
    for (i, c) in header.char_indices() {
        if escaped {
            escaped = false;
        } else if quoted && c == '\\' {
            escaped = true;
        } else if c == '"' {
            quoted = !quoted;
        } else if c == ',' && !quoted {
            items.push(&header[start..i]);
            start = i + 1;
        }
    }
    items.push(&header[start..]);
    items
}

fn unquote_header_value(raw: &str) -> String {
    let raw = raw.trim();
    let Some(inner) = raw.strip_prefix('"').and_then(|r| r.strip_suffix('"')) else {
        return raw.to_string();
    };
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => out.extend(chars.next()),
            other => out.push(other),
        }
    }
    out
}

/// หา challenge แบบ Bearer ในค่าของ WWW-Authenticate (มี scheme อื่นปนได้ เช่น `Basic realm="x", Bearer ...`)
fn parse_bearer_challenge(header: &str) -> Option<AuthChallenge> {
    let mut challenge = None;
    let mut in_bearer = false;
    for item in split_header_items(header) {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        // `Scheme` หรือ `Scheme ...` เริ่ม challenge ใหม่ ส่วน `name=value` เป็นพารามิเตอร์ของตัวเดิม
        let (first, rest) = item.split_once(char::is_whitespace).unwrap_or((item, ""));
        let rest = rest.trim_start();
        let param = if first.contains('=') || rest.starts_with('=') {
            Some(item)
        } else {
            in_bearer = first.eq_ignore_ascii_case("bearer");
            if in_bearer {
                challenge.get_or_insert_with(AuthChallenge::default);
            }
            (!rest.is_empty()).then_some(rest)
        };
        if !in_bearer {
            continue;
        }
        let Some((name, value)) = param.and_then(|p| p.split_once('=')) else {
            continue;
        };
        let value = Some(unquote_header_value(value)).filter(|v| !v.is_empty());
        let current = challenge.get_or_insert_with(AuthChallenge::default);
        match name.trim().to_ascii_lowercase().as_str() {
            "error" => current.error = value,
            "scope" => current.scope = value,
            "resource_metadata" => current.resource_metadata = value,
            _ => {}
        }
    }
    challenge
}

/// server ส่ง WWW-Authenticate มาหลายบรรทัดได้ จึงต้องอ่านทุกบรรทัด
fn response_challenge(resp: &ureq::Response) -> Option<AuthChallenge> {
    parse_bearer_challenge(&resp.all("www-authenticate").join(", "))
}

fn internal_ipv4(ip: std::net::Ipv4Addr) -> bool {
    ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified()
}

fn is_internal_host(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => internal_ipv4(ip),
        Some(url::Host::Ipv6(ip)) => match ip.to_ipv4_mapped() {
            Some(mapped) => internal_ipv4(mapped),
            None => ip.is_loopback() || ip.is_unspecified() || (ip.segments()[0] & 0xfe00) == 0xfc00 || (ip.segments()[0] & 0xffc0) == 0xfe80,
        },
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".localhost"),
        None => true,
    }
}

fn is_loopback_host(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

/// URL ของ MCP server ที่จะรับ token ได้: https หรือ http ที่อยู่ในเครื่องเท่านั้น
fn oauth_server_url(raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw.trim()).map_err(|_| OAUTH_ERR_BAD_SERVER.to_string())?;
    let secure = url.scheme() == "https" || (url.scheme() == "http" && is_loopback_host(&url));
    if !secure || !url.username().is_empty() || url.password().is_some() {
        return Err(OAUTH_ERR_BAD_SERVER.to_string());
    }
    Ok(url)
}

/// URL ที่ server ส่งมาให้เราเรียกหรือเปิดในเบราว์เซอร์ — ของ server ที่อาจไม่น่าเชื่อถือ จึงตรวจเข้มทุกตัว:
/// scheme อื่นอย่าง `file:` ห้ามเด็ดขาดเพราะจะถูกส่งให้ระบบปฏิบัติการเปิด
/// server ภายนอกชี้กลับเข้าเครือข่ายภายในไม่ได้ (SSRF) และ http ใช้ได้เฉพาะตอนทดสอบกับ server ในเครื่อง
fn oauth_url_allowed(server: &url::Url, raw: &str) -> Result<url::Url, String> {
    let insecure = || format!("{}: {}", OAUTH_ERR_INSECURE_ENDPOINT, raw.chars().take(200).collect::<String>());
    let url = url::Url::parse(raw).map_err(|_| insecure())?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(insecure());
    }
    match url.scheme() {
        "https" => {
            if is_internal_host(&url) && !is_internal_host(server) {
                return Err(insecure());
            }
        }
        "http" => {
            if !is_loopback_host(&url) || !is_loopback_host(server) {
                return Err(insecure());
            }
        }
        _ => return Err(insecure()),
    }
    Ok(url)
}

/// token ของ `resource` ใช้กับ URL นี้ได้ไหม: origin เดียวกันและ path อยู่ใต้ resource (query ไม่นับ)
fn resource_covers(resource: &url::Url, request: &url::Url) -> bool {
    if resource.origin() != request.origin() {
        return false;
    }
    let with_slash = |path: &str| if path.ends_with('/') { path.to_string() } else { format!("{}/", path) };
    with_slash(request.path()).starts_with(&with_slash(resource.path()))
}

fn protected_resource_candidates(server: &url::Url) -> Vec<String> {
    let origin = server.origin().ascii_serialization();
    let root = format!("{}/.well-known/oauth-protected-resource", origin);
    if server.path() == "/" || server.path().is_empty() {
        return vec![root];
    }
    let query = server.query().map(|q| format!("?{}", q)).unwrap_or_default();
    vec![format!("{}{}{}", root, server.path(), query), root]
}

fn authorization_server_candidates(issuer: &url::Url) -> Vec<String> {
    let origin = issuer.origin().ascii_serialization();
    let path = issuer.path().trim_end_matches('/');
    if path.is_empty() {
        return vec![
            format!("{}/.well-known/oauth-authorization-server", origin),
            format!("{}/.well-known/openid-configuration", origin),
        ];
    }
    vec![
        format!("{}/.well-known/oauth-authorization-server{}", origin, path),
        format!("{}/.well-known/openid-configuration{}", origin, path),
        format!("{}{}/.well-known/openid-configuration", origin, path),
    ]
}

fn oauth_agent() -> ureq::Agent {
    // ไม่ตาม redirect: ปลายทางใหม่จะข้ามการตรวจ oauth_url_allowed ไปได้
    ureq::AgentBuilder::new().timeout(OAUTH_HTTP_TIMEOUT).redirects(0).user_agent("dex-agent").build()
}

fn read_json_body<T: for<'de> Deserialize<'de>>(response: ureq::Response) -> Option<T> {
    response.into_string().ok().and_then(|text| serde_json::from_str(&text).ok())
}

/// 200 + JSON เท่านั้นที่นับว่าเจอเอกสาร
fn fetch_oauth_json<T: for<'de> Deserialize<'de>>(agent: &ureq::Agent, url: &url::Url) -> Option<T> {
    match agent.get(url.as_str()).set("Accept", "application/json").call() {
        Ok(resp) if resp.status() == 200 => read_json_body(resp),
        _ => None,
    }
}

#[derive(Deserialize)]
struct ProtectedResourceMetadata {
    resource: String,
    authorization_servers: Vec<String>,
    #[serde(default)]
    scopes_supported: Option<Vec<String>>,
}

#[derive(Deserialize, Clone)]
struct AuthorizationServerMetadata {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    #[serde(default)]
    registration_endpoint: Option<String>,
    #[serde(default)]
    code_challenge_methods_supported: Option<Vec<String>>,
    #[serde(default)]
    token_endpoint_auth_methods_supported: Option<Vec<String>>,
    #[serde(default)]
    scopes_supported: Option<Vec<String>>,
    #[serde(default)]
    authorization_response_iss_parameter_supported: Option<bool>,
}

/// URL จาก WWW-Authenticate ก่อน แล้วค่อย well-known ตามสเปก — `resource` ต้องครอบ URL ที่เราจะเรียกจริง
fn discover_protected_resource(
    agent: &ureq::Agent,
    server: &url::Url,
    from_challenge: Option<&str>,
) -> Result<ProtectedResourceMetadata, String> {
    let mut last_error = OAUTH_ERR_NO_METADATA.to_string();
    let mut candidates = Vec::new();
    if let Some(raw) = from_challenge {
        candidates.push(oauth_url_allowed(server, raw)?);
    }
    for raw in protected_resource_candidates(server) {
        candidates.push(oauth_url_allowed(server, &raw)?);
    }
    for candidate in candidates {
        let Some(doc) = fetch_oauth_json::<ProtectedResourceMetadata>(agent, &candidate) else {
            continue;
        };
        let covered = url::Url::parse(&doc.resource).map(|r| resource_covers(&r, server)).unwrap_or(false);
        if !covered {
            last_error = format!("{}: {}", OAUTH_ERR_RESOURCE_MISMATCH, doc.resource.chars().take(200).collect::<String>());
            continue;
        }
        if !doc.authorization_servers.is_empty() {
            return Ok(doc);
        }
    }
    Err(last_error)
}

/// เอกสารที่ `issuer` ไม่ตรงกับ URL ที่ใช้สร้าง well-known ต้องทิ้งตามสเปก และต้องยืนยันได้ว่ารองรับ PKCE แบบ S256
fn discover_authorization_server(
    agent: &ureq::Agent,
    server: &url::Url,
    issuers: &[String],
) -> Result<AuthorizationServerMetadata, String> {
    let mut last_error = OAUTH_ERR_NO_AS_METADATA.to_string();
    for issuer in issuers {
        let issuer_url = match oauth_url_allowed(server, issuer) {
            Ok(url) => url,
            Err(e) => {
                last_error = e;
                continue;
            }
        };
        for raw in authorization_server_candidates(&issuer_url) {
            let Ok(candidate) = oauth_url_allowed(server, &raw) else {
                continue;
            };
            let Some(doc) = fetch_oauth_json::<AuthorizationServerMetadata>(agent, &candidate) else {
                continue;
            };
            if &doc.issuer != issuer {
                continue;
            }
            let supports_s256 = doc.code_challenge_methods_supported.as_deref().unwrap_or_default().iter().any(|m| m == "S256");
            if !supports_s256 {
                last_error = OAUTH_ERR_NO_PKCE.to_string();
                continue;
            }
            let endpoints = [Some(&doc.authorization_endpoint), Some(&doc.token_endpoint), doc.registration_endpoint.as_ref()];
            let checked = endpoints.into_iter().flatten().try_for_each(|e| oauth_url_allowed(server, e).map(|_| ()));
            match checked {
                Ok(()) => return Ok(doc),
                Err(e) => last_error = e,
            }
        }
    }
    Err(last_error)
}

fn merge_scopes<'a>(groups: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let mut merged: Vec<&str> = Vec::new();
    for scope in groups.into_iter().flat_map(str::split_whitespace) {
        if !merged.contains(&scope) {
            merged.push(scope);
        }
    }
    (!merged.is_empty()).then(|| merged.join(" "))
}

/// scope จาก 401 มาก่อน ไม่มีค่อยใช้ scopes_supported ของ resource (ไม่มีทั้งคู่ = ไม่ส่ง scope)
/// รวม scope เดิมและที่ server เพิ่งขอ (403) ไว้ด้วยเพื่อไม่ให้สิทธิ์เดิมหายตอนขอเพิ่ม
/// `offline_access` เติมเมื่อมี scope อื่นอยู่แล้วเท่านั้น: ถ้าขอตัวเดียว บาง server จะออก token ที่ไม่มีสิทธิ์ใช้งานจริง
fn select_oauth_scope(
    challenge: Option<&str>,
    resource_supported: Option<&[String]>,
    server_supported: Option<&[String]>,
    previous: Option<&str>,
    extra: Option<&str>,
) -> Option<String> {
    let fallback = resource_supported.map(|list| list.join(" "));
    let base = challenge.filter(|s| !s.trim().is_empty()).or(fallback.as_deref());
    let scope = merge_scopes([previous, base, extra].into_iter().flatten())?;
    let offers_offline = server_supported.unwrap_or_default().iter().any(|s| s == "offline_access");
    if offers_offline {
        return merge_scopes([scope.as_str(), "offline_access"]);
    }
    Some(scope)
}

/// client ของ Dex เป็น public client ถ้า server รับ ไม่งั้นใช้ secret ที่ได้ตอนลงทะเบียน (Supabase ไม่รับ `none`)
fn choose_client_auth_method(supported: Option<&[String]>) -> &'static str {
    let Some(list) = supported else {
        return "none";
    };
    let has = |method: &str| list.iter().any(|m| m == method);
    if has("none") {
        "none"
    } else if has("client_secret_post") {
        "client_secret_post"
    } else if has("client_secret_basic") {
        "client_secret_basic"
    } else {
        "none"
    }
}

/// ข้อมูลการล็อกอินของ server หนึ่งตัว — ไม่ derive Debug เพื่อไม่ให้ token โผล่ใน log โดยบังเอิญ
#[derive(Serialize, Deserialize, Clone)]
struct OauthClient {
    client_id: String,
    #[serde(default)]
    client_secret: Option<String>,
    auth_method: String,
    redirect_uri: String,
    #[serde(default)]
    registered_scope: Option<String>,
    #[serde(default)]
    secret_expires_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone)]
struct OauthRecord {
    /// token ใช้ได้กับ resource นี้เท่านั้น — config เปลี่ยน URL ไปที่อื่น token ก็ไม่ถูกส่งตาม
    resource: String,
    /// client ผูกกับ issuer ที่ออกให้ เปลี่ยน authorization server แล้วต้องลงทะเบียนใหม่
    issuer: String,
    token_endpoint: String,
    client: OauthClient,
    /// server อาจไม่รู้จัก client นี้แล้ว: login ครั้งหน้าต้องลงทะเบียนใหม่ (refresh ยังใช้ตัวเดิมที่ออก token นี้)
    #[serde(default)]
    client_stale: bool,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    /// unix seconds (ไม่มี = server ไม่ได้บอกอายุ ใช้จนกว่าจะโดน 401)
    #[serde(default)]
    expires_at: Option<u64>,
    #[serde(default)]
    scope: Option<String>,
}

/// สิ่งเดียวที่ webview เห็นเกี่ยวกับการล็อกอิน — ห้ามเพิ่ม field ที่เป็นความลับ
#[derive(Serialize, Debug, PartialEq)]
pub struct OauthStatus {
    signed_in: bool,
    expires_at: Option<u64>,
    can_refresh: bool,
    issuer: Option<String>,
    scope: Option<String>,
}

/// ข้อความหน้าเว็บหลังล็อกอิน มาจาก i18n.ts เพื่อให้ตรงภาษาที่ผู้ใช้เลือก
#[derive(Deserialize)]
pub struct OauthPages {
    success: String,
    failure: String,
}

trait OauthStore: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, String>;
    fn set(&self, name: &str, value: &[u8]) -> Result<(), String>;
    /// ไม่มีอยู่แล้วก็ถือว่าสำเร็จ
    fn delete(&self, name: &str) -> Result<(), String>;
}

/// Windows Credential Manager — ใช้ secret แบบไบต์ เพราะ set_password แปลงเป็น UTF-16 ซึ่งกินที่สองเท่า
struct CredentialStore;

impl OauthStore for CredentialStore {
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, name).map_err(|e| format!("{}: {}", OAUTH_ERR_STORE, e))?;
        match entry.get_secret() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("{}: {}", OAUTH_ERR_STORE, e)),
        }
    }

    fn set(&self, name: &str, value: &[u8]) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, name).map_err(|e| format!("{}: {}", OAUTH_ERR_STORE, e))?;
        entry.set_secret(value).map_err(|e| format!("{}: {}", OAUTH_ERR_STORE, e))
    }

    fn delete(&self, name: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, name).map_err(|e| format!("{}: {}", OAUTH_ERR_STORE, e))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("{}: {}", OAUTH_ERR_STORE, e)),
        }
    }
}

fn oauth_part_name(key: &str, part: usize) -> String {
    format!("{}{}.{}", OAUTH_VAULT_PREFIX, key, part)
}

fn validate_oauth_key(key: &str) -> Result<(), String> {
    if valid_provider_id(key) {
        Ok(())
    } else {
        Err(format!("{}: invalid server name", OAUTH_ERR_STORE))
    }
}

/// ไบต์แรกของส่วนที่ 0 บอกจำนวนส่วนทั้งหมด — เขียนส่วนนี้ท้ายสุด เขียนค้างกลางทางจึงอ่านไม่ผ่านแทนที่จะได้ของเพี้ยน
fn oauth_save(store: &dyn OauthStore, key: &str, record: &OauthRecord) -> Result<(), String> {
    validate_oauth_key(key)?;
    let json = serde_json::to_vec(record).map_err(|e| format!("{}: {}", OAUTH_ERR_STORE, e))?;
    let parts: Vec<&[u8]> = json.chunks(OAUTH_PART_BYTES).collect();
    if parts.len() > OAUTH_MAX_PARTS {
        return Err(format!("{}: token too large", OAUTH_ERR_STORE));
    }
    for (i, part) in parts.iter().enumerate().skip(1) {
        store.set(&oauth_part_name(key, i), part)?;
    }
    let mut first = vec![parts.len() as u8];
    first.extend_from_slice(parts.first().copied().unwrap_or_default());
    store.set(&oauth_part_name(key, 0), &first)?;
    for i in parts.len()..OAUTH_MAX_PARTS {
        store.delete(&oauth_part_name(key, i))?;
    }
    Ok(())
}

/// ข้อมูลเสีย = เหมือนยังไม่ได้ล็อกอิน ผู้ใช้ล็อกอินใหม่แล้วเขียนทับได้
fn oauth_load(store: &dyn OauthStore, key: &str) -> Result<Option<OauthRecord>, String> {
    validate_oauth_key(key)?;
    let Some(first) = store.get(&oauth_part_name(key, 0))? else {
        return Ok(None);
    };
    let Some((&count, head)) = first.split_first() else {
        return Ok(None);
    };
    let mut json = head.to_vec();
    for i in 1..count as usize {
        match store.get(&oauth_part_name(key, i))? {
            Some(part) => json.extend_from_slice(&part),
            None => return Ok(None),
        }
    }
    Ok(serde_json::from_slice(&json).ok())
}

/// ลบทุกส่วนโดยไม่อิงจำนวนที่บันทึกไว้ ข้อมูลที่เขียนค้างไว้จึงไม่ตกค้าง
fn oauth_delete(store: &dyn OauthStore, key: &str) -> Result<(), String> {
    validate_oauth_key(key)?;
    // ส่วนที่ 0 ไปก่อน: ถ้าลบไม่ครบ ส่วนที่เหลือก็อ่านเป็น token ไม่ได้แล้ว
    (0..OAUTH_MAX_PARTS).try_for_each(|i| store.delete(&oauth_part_name(key, i)))
}

/// อ่าน ต่ออายุ และบันทึกของ server เดียวกันทีละงาน — refresh token ใช้ได้ครั้งเดียว
/// ถ้าสอง request ต่ออายุพร้อมกัน ตัวที่ช้ากว่าจะส่งของเก่าและบาง server จะยกเลิกการล็อกอินทั้งหมด
fn oauth_lock(key: &str) -> Arc<Mutex<()>> {
    static LOCKS: std::sync::OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = std::sync::OnceLock::new();
    LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(key.to_string())
        .or_default()
        .clone()
}

fn with_oauth_lock<T>(key: &str, work: impl FnOnce() -> T) -> T {
    let lock = oauth_lock(key);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    work()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// ไม่มี refresh token ก็ไม่ต้องกันเวลา เพราะเผื่อไว้แล้วทำอะไรต่อไม่ได้
fn access_token_expired(record: &OauthRecord, now: u64) -> bool {
    let leeway = if record.refresh_token.is_some() { OAUTH_EXPIRY_LEEWAY_SECS } else { 0 };
    record.expires_at.map(|at| now + leeway >= at).unwrap_or(false)
}

#[derive(Deserialize)]
struct TokenResponse {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    expires_in: Option<serde_json::Value>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

struct OauthTokenFailure {
    /// server ตอบชัดเจนว่าไม่รับ (400/401 พร้อม `error`) ต่างจากเน็ตหลุดหรือ server ล่ม
    rejected: bool,
    client_rejected: bool,
    detail: String,
}

/// POST ไปที่ token endpoint พร้อมการยืนยันตัวตนของ client และ `resource`
fn post_token_request<'a>(
    token_endpoint: &str,
    client: &'a OauthClient,
    resource: &'a str,
    mut form: Vec<(&'a str, &'a str)>,
) -> Result<TokenResponse, OauthTokenFailure> {
    use base64::Engine;
    form.push(("resource", resource));
    let mut request = oauth_agent().post(token_endpoint).set("Accept", "application/json");
    match (client.auth_method.as_str(), client.client_secret.as_deref()) {
        ("client_secret_basic", Some(secret)) => {
            let encode = |value: &str| url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>();
            let credentials = format!("{}:{}", encode(&client.client_id), encode(secret));
            let encoded = base64::engine::general_purpose::STANDARD.encode(credentials);
            request = request.set("Authorization", &format!("Basic {}", encoded));
        }
        ("client_secret_post", Some(secret)) => {
            form.push(("client_id", client.client_id.as_str()));
            form.push(("client_secret", secret));
        }
        _ => form.push(("client_id", client.client_id.as_str())),
    }
    let response = match request.send_form(&form) {
        Ok(r) | Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(OauthTokenFailure { rejected: false, client_rejected: false, detail: e.to_string() }),
    };
    let status = response.status();
    match read_json_body::<TokenResponse>(response) {
        Some(token) if status == 200 && token.error.is_none() => Ok(token),
        Some(token) if (status == 400 || status == 401) && token.error.is_some() => {
            let error = token.error.unwrap_or_default();
            Err(OauthTokenFailure {
                rejected: true,
                client_rejected: error == "invalid_client" || error == "unauthorized_client",
                detail: limited_detail(&error, token.error_description.as_deref()),
            })
        }
        _ => Err(OauthTokenFailure { rejected: false, client_rejected: false, detail: format!("HTTP {}", status) }),
    }
}

/// ข้อความจาก server ไม่น่าเชื่อถือและอาจยาวมาก — ตัดสั้นก่อนแสดง
fn limited_detail(error: &str, description: Option<&str>) -> String {
    let text = match description {
        Some(d) => format!("{} ({})", error, d),
        None => error.to_string(),
    };
    text.chars().filter(|c| !c.is_control()).take(300).collect()
}

/// ค่าที่จะเข้า header ต้องไม่มีอักขระควบคุม (server ที่ไม่น่าเชื่อถืออาจแทรก CRLF มา)
fn usable_token(token: Option<String>) -> Option<String> {
    token.filter(|t| !t.is_empty() && !t.chars().any(char::is_control))
}

/// ใช้คำตอบของ token endpoint กับ record — refresh token ใหม่ไม่มีมาก็เก็บตัวเดิมไว้ตามสเปก
fn apply_token_response(record: &mut OauthRecord, token: TokenResponse, now: u64) -> Result<(), String> {
    let bearer = token.token_type.as_deref().map(|t| t.eq_ignore_ascii_case("bearer")).unwrap_or(true);
    let access_token = usable_token(token.access_token).filter(|_| bearer).ok_or_else(|| format!("{}: no bearer token", OAUTH_ERR_TOKEN))?;
    let lifetime = token.expires_in.and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
    record.access_token = Some(access_token);
    record.expires_at = lifetime.map(|seconds| now + seconds);
    if let Some(refresh) = usable_token(token.refresh_token) {
        record.refresh_token = Some(refresh);
    }
    if token.scope.is_some() {
        record.scope = token.scope;
    }
    Ok(())
}

/// ต่ออายุแล้วบันทึก: server ปฏิเสธ = ล้าง token ให้ผู้ใช้ล็อกอินใหม่ (Ok(None))
/// เน็ตหลุดหรือ server ล่ม = เก็บ token ไว้ลองใหม่ภายหลัง (Err) ไม่ไล่ผู้ใช้ออกจากระบบเพราะปัญหาชั่วคราว
fn refresh_oauth_record(store: &dyn OauthStore, key: &str, record: &mut OauthRecord) -> Result<Option<String>, String> {
    let Some(refresh_token) = record.refresh_token.clone() else {
        record.access_token = None;
        record.expires_at = None;
        oauth_save(store, key, record)?;
        return Ok(None);
    };
    let form = vec![("grant_type", "refresh_token"), ("refresh_token", refresh_token.as_str())];
    match post_token_request(&record.token_endpoint, &record.client, &record.resource, form) {
        Ok(token) => {
            apply_token_response(record, token, now_secs())?;
            oauth_save(store, key, record)?;
            Ok(record.access_token.clone())
        }
        Err(failure) if failure.rejected => {
            record.access_token = None;
            record.refresh_token = None;
            record.expires_at = None;
            record.client_stale |= failure.client_rejected;
            oauth_save(store, key, record)?;
            Ok(None)
        }
        Err(failure) => Err(format!("{}: {}", OAUTH_ERR_REFRESH, failure.detail)),
    }
}

/// token ใช้กับ URL นี้ได้ไหม — ไม่ผ่านก็ส่ง request แบบไม่มี token แล้ว server จะตอบ 401 ให้ผู้ใช้ล็อกอินเอง
fn oauth_record_matches(record: &OauthRecord, request: &url::Url) -> bool {
    let secure = request.scheme() == "https" || (request.scheme() == "http" && is_loopback_host(request));
    secure && url::Url::parse(&record.resource).map(|r| resource_covers(&r, request)).unwrap_or(false)
}

/// access token ที่จะใส่ใน request นี้ (ต่ออายุให้ถ้าจำเป็น) — None = ยังไม่ได้ล็อกอิน
fn oauth_bearer(store: &dyn OauthStore, key: &str, url: &str) -> Result<Option<String>, String> {
    validate_oauth_key(key)?;
    let Ok(request) = url::Url::parse(url) else {
        return Ok(None);
    };
    with_oauth_lock(key, || {
        let Some(mut record) = oauth_load(store, key)? else {
            return Ok(None);
        };
        if !oauth_record_matches(&record, &request) {
            return Ok(None);
        }
        match &record.access_token {
            Some(token) if !access_token_expired(&record, now_secs()) => Ok(Some(token.clone())),
            None if record.refresh_token.is_none() => Ok(None),
            _ => refresh_oauth_record(store, key, &mut record),
        }
    })
}

/// server ตอบ 401 ทั้งที่ token ยังไม่หมดอายุ (ถูกเพิกถอน ฯลฯ) — None = ต้องล็อกอินใหม่
fn oauth_bearer_after_rejection(store: &dyn OauthStore, key: &str, url: &str, rejected: &str) -> Result<Option<String>, String> {
    let Ok(request) = url::Url::parse(url) else {
        return Ok(None);
    };
    with_oauth_lock(key, || {
        let Some(mut record) = oauth_load(store, key)? else {
            return Ok(None);
        };
        if !oauth_record_matches(&record, &request) {
            return Ok(None);
        }
        // request อื่นเพิ่งต่ออายุให้แล้ว
        if record.access_token.as_deref().is_some_and(|current| current != rejected) {
            return Ok(record.access_token.clone());
        }
        refresh_oauth_record(store, key, &mut record)
    })
}

fn oauth_status_of(store: &dyn OauthStore, key: &str, url: &str) -> Result<OauthStatus, String> {
    let record = with_oauth_lock(key, || oauth_load(store, key))?;
    let request = url::Url::parse(url).ok();
    let current = record.filter(|r| request.as_ref().is_some_and(|req| oauth_record_matches(r, req)));
    Ok(match current {
        Some(record) => {
            let usable = record.access_token.is_some() && !access_token_expired(&record, now_secs());
            OauthStatus {
                signed_in: usable || record.refresh_token.is_some(),
                expires_at: record.expires_at,
                can_refresh: record.refresh_token.is_some(),
                issuer: Some(record.issuer),
                scope: record.scope,
            }
        }
        None => OauthStatus { signed_in: false, expires_at: None, can_refresh: false, issuer: None, scope: None },
    })
}

fn random_url_token() -> Result<String, String> {
    use base64::Engine;
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("{}: {}", OAUTH_ERR_LISTENER, e))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

fn pkce_challenge(verifier: &str) -> String {
    use base64::Engine;
    use sha2::Digest;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier.as_bytes()))
}

fn register_oauth_client(
    agent: &ureq::Agent,
    metadata: &AuthorizationServerMetadata,
    redirect_uri: &str,
    scope: Option<&str>,
) -> Result<OauthClient, String> {
    let endpoint = metadata.registration_endpoint.as_deref().ok_or_else(|| OAUTH_ERR_NO_REGISTRATION.to_string())?;
    let requested_method = choose_client_auth_method(metadata.token_endpoint_auth_methods_supported.as_deref());
    let mut body = serde_json::json!({
        "client_name": "Dex",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": requested_method,
        // ไม่ระบุจะเป็น "web" ตาม OIDC ซึ่งไม่รับ redirect แบบ loopback
        "application_type": "native",
    });
    if let Some(scope) = scope {
        body["scope"] = scope.into();
    }

    #[derive(Deserialize)]
    struct Registration {
        #[serde(default)]
        client_id: Option<String>,
        #[serde(default)]
        client_secret: Option<String>,
        #[serde(default)]
        token_endpoint_auth_method: Option<String>,
        #[serde(default)]
        client_secret_expires_at: Option<u64>,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        error_description: Option<String>,
    }

    let request = agent.post(endpoint).set("Accept", "application/json").set("Content-Type", "application/json");
    let response = match request.send_string(&body.to_string()) {
        Ok(r) | Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(format!("{}: {}", OAUTH_ERR_NETWORK, e)),
    };
    let status = response.status();
    let fail = |detail: String| format!("{}: {}", OAUTH_ERR_REGISTRATION, detail);
    let registration = read_json_body::<Registration>(response).ok_or_else(|| fail(format!("HTTP {}", status)))?;
    if status != 200 && status != 201 {
        let error = registration.error.as_deref().unwrap_or("error");
        return Err(fail(format!("HTTP {}: {}", status, limited_detail(error, registration.error_description.as_deref()))));
    }
    let client_id = registration.client_id.filter(|id| !id.is_empty()).ok_or_else(|| fail("no client_id".to_string()))?;
    let client_secret = registration.client_secret.filter(|s| !s.is_empty());
    let auth_method = match (registration.token_endpoint_auth_method, &client_secret) {
        (Some(method), Some(_)) => method,
        (None, Some(_)) => requested_method.to_string(),
        (_, None) => "none".to_string(),
    };
    Ok(OauthClient {
        client_id,
        client_secret,
        auth_method,
        redirect_uri: redirect_uri.to_string(),
        registered_scope: scope.map(str::to_string),
        // 0 ตาม RFC 7591 แปลว่าไม่หมดอายุ
        secret_expires_at: registration.client_secret_expires_at.filter(|at| *at != 0),
    })
}

/// client เดิมใช้ต่อได้เมื่อมาจาก issuer เดียวกัน และลงทะเบียนครอบ scope ที่จะขอ
fn reusable_oauth_client(previous: Option<&OauthRecord>, issuer: &str, scope: Option<&str>, now: u64) -> Option<OauthClient> {
    let record = previous.filter(|r| r.issuer == issuer && !r.client_stale)?;
    let client = &record.client;
    if client.secret_expires_at.is_some_and(|at| at <= now) {
        return None;
    }
    let registered = client.registered_scope.as_deref().unwrap_or("");
    let covered = scope.unwrap_or("").split_whitespace().all(|s| registered.split_whitespace().any(|r| r == s));
    covered.then(|| client.clone())
}

/// ผูกกับ 127.0.0.1 เท่านั้น ไม่ใช่ 0.0.0.0 — เครื่องอื่นในเครือข่ายยิงเข้ามาไม่ได้
/// ลองพอร์ตเดิมก่อน เพราะ server หลายตัวเทียบ redirect_uri ตรงตัวทั้งพอร์ต
fn bind_oauth_listener(preferred_port: Option<u16>) -> Result<std::net::TcpListener, String> {
    let bind = |port: u16| std::net::TcpListener::bind(("127.0.0.1", port));
    let listener = preferred_port
        .and_then(|port| bind(port).ok())
        .map(Ok)
        .unwrap_or_else(|| bind(0))
        .map_err(|e| format!("{}: {}", OAUTH_ERR_LISTENER, e))?;
    listener.set_nonblocking(true).map_err(|e| format!("{}: {}", OAUTH_ERR_LISTENER, e))?;
    Ok(listener)
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// หน้าเว็บตายตัวบน origin ของ loopback: ไม่สะท้อนค่าจาก query และไม่มีสคริปต์
fn write_oauth_page(stream: &mut std::net::TcpStream, status: &str, message: &str) {
    use std::io::Write;
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Dex</title><style>body{{font:16px/1.6 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;padding:0 16px;text-align:center}}</style></head><body><p>{}</p></body></html>",
        escape_html(message)
    );
    let head = format!(
        "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        status,
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(body.as_bytes()));
}

struct OauthCallback {
    stream: std::net::TcpStream,
    code: Option<String>,
    iss: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/// อ่าน request หนึ่งตัวจาก socket ที่เพิ่ง accept (เวลาจำกัด โปรแกรมอื่นถือ socket ค้างเพื่อกันการล็อกอินไม่ได้)
fn read_callback_request(stream: &mut std::net::TcpStream) -> Option<String> {
    use std::io::Read;
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    let mut buf = [0u8; 8192];
    let mut len = 0;
    while len < buf.len() && !buf[..len].windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut buf[len..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => len += n,
        }
    }
    Some(String::from_utf8_lossy(&buf[..len]).into_owned())
}

/// รอ redirect ของเบราว์เซอร์ที่ loopback — request ที่ `state` ไม่ตรงถูกทิ้งเสมอและไม่ทำให้การล็อกอินล้ม
/// มิฉะนั้นเว็บหรือโปรแกรมใดก็ตามที่ยิงมาที่พอร์ตนี้จะล้มการล็อกอินของผู้ใช้ได้
fn wait_for_oauth_callback(
    listener: &std::net::TcpListener,
    state: &str,
    cancel: &std::sync::atomic::AtomicBool,
    timeout: Duration,
    failure_page: &str,
) -> Result<OauthCallback, String> {
    let port = listener.local_addr().map_err(|e| format!("{}: {}", OAUTH_ERR_LISTENER, e))?.port();
    let expected_host = format!("127.0.0.1:{}", port);
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(OAUTH_ERR_CANCELLED.to_string());
        }
        if std::time::Instant::now() >= deadline {
            return Err(OAUTH_ERR_TIMEOUT.to_string());
        }
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
            Err(e) => return Err(format!("{}: {}", OAUTH_ERR_LISTENER, e)),
        };
        let Some(request) = read_callback_request(&mut stream) else {
            continue;
        };
        let mut lines = request.lines();
        let request_line = lines.next().unwrap_or_default();
        let mut words = request_line.split_whitespace();
        let (method, target) = (words.next().unwrap_or_default(), words.next().unwrap_or_default());
        let host_ok = lines.any(|line| {
            line.split_once(':')
                .is_some_and(|(name, value)| name.eq_ignore_ascii_case("host") && value.trim() == expected_host)
        });
        if !host_ok {
            write_oauth_page(&mut stream, "403 Forbidden", failure_page);
            continue;
        }
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        if method != "GET" || path != OAUTH_CALLBACK_PATH {
            write_oauth_page(&mut stream, "404 Not Found", failure_page);
            continue;
        }
        let params: HashMap<String, String> = url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();
        if params.get("state").map(String::as_str) != Some(state) {
            write_oauth_page(&mut stream, "400 Bad Request", failure_page);
            continue;
        }
        let param = |name: &str| params.get(name).cloned();
        return Ok(OauthCallback {
            code: param("code"),
            iss: param("iss"),
            error: param("error"),
            error_description: param("error_description"),
            stream,
        });
    }
}

/// RFC 9207 ตามตารางในสเปก ทำก่อนส่ง code ไปไหน และก่อนอ่าน `error` ของ response
fn check_callback_issuer(expected: &str, advertised: Option<bool>, iss: Option<&str>) -> Result<(), String> {
    match iss {
        Some(value) if value == expected => Ok(()),
        Some(_) => Err(OAUTH_ERR_ISSUER.to_string()),
        None if advertised == Some(true) => Err(OAUTH_ERR_ISSUER.to_string()),
        None => Ok(()),
    }
}

/// ลองล็อกอินเพื่อเอา challenge — server ยังไม่ได้รับ token ในขั้นนี้
fn probe_oauth_challenge(agent: &ureq::Agent, server: &url::Url) -> Result<Option<AuthChallenge>, String> {
    let request = agent
        .post(server.as_str())
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream");
    let response = match request.send_string(OAUTH_INITIALIZE_PROBE) {
        Ok(r) | Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(format!("{}: {}", OAUTH_ERR_NETWORK, e)),
    };
    Ok(if response.status() == 401 { response_challenge(&response) } else { None })
}

fn authorization_url(
    metadata: &AuthorizationServerMetadata,
    client: &OauthClient,
    resource: &str,
    scope: Option<&str>,
    state: &str,
    code_challenge: &str,
) -> Result<url::Url, String> {
    let mut url = url::Url::parse(&metadata.authorization_endpoint).map_err(|_| OAUTH_ERR_INSECURE_ENDPOINT.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", &client.client_id)
            .append_pair("redirect_uri", &client.redirect_uri)
            .append_pair("code_challenge", code_challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", state)
            .append_pair("resource", resource);
        if let Some(scope) = scope {
            query.append_pair("scope", scope);
        }
    }
    Ok(url)
}

fn mark_oauth_client_stale(store: &dyn OauthStore, key: &str) {
    with_oauth_lock(key, || {
        if let Ok(Some(mut record)) = oauth_load(store, key) {
            record.client_stale = true;
            let _ = oauth_save(store, key, &record);
        }
    });
}

/// flow ทั้งหมดของการล็อกอินหนึ่งครั้ง — `open_browser` แยกออกมาเพื่อให้เทสต์เล่นบทเบราว์เซอร์ได้
#[allow(clippy::too_many_arguments)]
fn oauth_login_flow(
    store: &dyn OauthStore,
    key: &str,
    server_url: &str,
    extra_scope: Option<&str>,
    pages: &OauthPages,
    cancel: &std::sync::atomic::AtomicBool,
    timeout: Duration,
    open_browser: &dyn Fn(&str) -> Result<(), String>,
) -> Result<OauthStatus, String> {
    validate_oauth_key(key)?;
    let server = oauth_server_url(server_url)?;
    let agent = oauth_agent();

    let challenge = probe_oauth_challenge(&agent, &server)?.unwrap_or_default();
    let resource_doc = discover_protected_resource(&agent, &server, challenge.resource_metadata.as_deref())?;
    // issuer ที่ผ่านการตรวจแล้วคือค่าที่ใช้เทียบกับ `iss` ตอน redirect กลับมา
    let metadata = discover_authorization_server(&agent, &server, &resource_doc.authorization_servers)?;

    let previous = with_oauth_lock(key, || oauth_load(store, key))?;
    let scope = select_oauth_scope(
        challenge.scope.as_deref(),
        resource_doc.scopes_supported.as_deref(),
        metadata.scopes_supported.as_deref(),
        previous.as_ref().filter(|r| r.issuer == metadata.issuer).and_then(|r| r.scope.as_deref()),
        extra_scope,
    );

    let known_client = reusable_oauth_client(previous.as_ref(), &metadata.issuer, scope.as_deref(), now_secs());
    let preferred_port = known_client
        .as_ref()
        .and_then(|c| url::Url::parse(&c.redirect_uri).ok())
        .and_then(|u| u.port());
    let listener = bind_oauth_listener(preferred_port)?;
    let port = listener.local_addr().map_err(|e| format!("{}: {}", OAUTH_ERR_LISTENER, e))?.port();
    let redirect_uri = format!("http://127.0.0.1:{}{}", port, OAUTH_CALLBACK_PATH);
    let (client, reused_client) = match known_client.filter(|c| c.redirect_uri == redirect_uri) {
        Some(client) => (client, true),
        None => (register_oauth_client(&agent, &metadata, &redirect_uri, scope.as_deref())?, false),
    };

    let verifier = random_url_token()?;
    let state = random_url_token()?;
    let url = authorization_url(&metadata, &client, &resource_doc.resource, scope.as_deref(), &state, &pkce_challenge(&verifier))?;
    open_browser(url.as_str())?;

    let mut callback = match wait_for_oauth_callback(&listener, &state, cancel, timeout, &pages.failure) {
        Ok(callback) => callback,
        Err(e) => {
            // server อาจลืม client ที่ลงทะเบียนไว้นานแล้วและค้างอยู่ที่หน้า error ในเบราว์เซอร์
            // ลบทิ้งเพื่อให้ครั้งหน้าลงทะเบียนใหม่ ไม่ติดอยู่กับ client เสียตลอดไป
            if reused_client {
                mark_oauth_client_stale(store, key);
            }
            return Err(e);
        }
    };

    let outcome = (|| {
        check_callback_issuer(&metadata.issuer, metadata.authorization_response_iss_parameter_supported, callback.iss.as_deref())?;
        if let Some(error) = callback.error.as_deref() {
            let code = if error == "access_denied" { OAUTH_ERR_DENIED } else { OAUTH_ERR_AUTHORIZATION };
            return Err(format!("{}: {}", code, limited_detail(error, callback.error_description.as_deref())));
        }
        let code = callback.code.as_deref().filter(|c| !c.is_empty()).ok_or_else(|| OAUTH_ERR_AUTHORIZATION.to_string())?;
        let form = vec![
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", client.redirect_uri.as_str()),
            ("code_verifier", verifier.as_str()),
        ];
        let token = post_token_request(&metadata.token_endpoint, &client, &resource_doc.resource, form).map_err(|failure| {
            if failure.client_rejected {
                mark_oauth_client_stale(store, key);
            }
            format!("{}: {}", OAUTH_ERR_TOKEN, failure.detail)
        })?;
        let mut record = OauthRecord {
            resource: resource_doc.resource.clone(),
            issuer: metadata.issuer.clone(),
            token_endpoint: metadata.token_endpoint.clone(),
            client: client.clone(),
            client_stale: false,
            access_token: None,
            refresh_token: None,
            expires_at: None,
            scope: scope.clone(),
        };
        apply_token_response(&mut record, token, now_secs())?;
        with_oauth_lock(key, || oauth_save(store, key, &record))?;
        oauth_status_of(store, key, server.as_str())
    })();

    match &outcome {
        Ok(_) => write_oauth_page(&mut callback.stream, "200 OK", &pages.success),
        Err(_) => write_oauth_page(&mut callback.stream, "400 Bad Request", &pages.failure),
    }
    outcome
}

/// การล็อกอินที่กำลังรออยู่ของแต่ละ server — เริ่มใหม่หรือกดยกเลิกแล้วตัวเก่าต้องหยุดและคืนพอร์ต
fn oauth_pending() -> &'static Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>> {
    static PENDING: std::sync::OnceLock<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>> = std::sync::OnceLock::new();
    PENDING.get_or_init(Default::default)
}

fn oauth_cancel_pending(key: &str) {
    if let Some(flag) = oauth_pending().lock().unwrap_or_else(|e| e.into_inner()).remove(key) {
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// เปิดเบราว์เซอร์ของระบบให้ผู้ใช้ล็อกอินเอง แล้วรอจนกว่าจะกลับมาหรือหมดเวลา
#[tauri::command]
async fn mcp_oauth_login(app: AppHandle, key: String, url: String, scope: Option<String>, pages: OauthPages) -> Result<OauthStatus, String> {
    oauth_cancel_pending(&key);
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    oauth_pending().lock().unwrap_or_else(|e| e.into_inner()).insert(key.clone(), cancel.clone());
    let flag = cancel.clone();
    let login_key = key.clone();
    let result = tokio::task::spawn_blocking(move || {
        use tauri_plugin_opener::OpenerExt;
        oauth_login_flow(&CredentialStore, &login_key, &expand_env(&url), scope.as_deref(), &pages, &flag, OAUTH_LOGIN_TIMEOUT, &|auth_url: &str| {
            app.opener().open_url(auth_url, None::<&str>).map_err(|e| format!("{}: {}", OAUTH_ERR_BROWSER, e))
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    let mut pending = oauth_pending().lock().unwrap_or_else(|e| e.into_inner());
    if pending.get(&key).is_some_and(|flag| Arc::ptr_eq(flag, &cancel)) {
        pending.remove(&key);
    }
    result
}

#[tauri::command]
fn mcp_oauth_cancel(key: String) {
    oauth_cancel_pending(&key);
}

/// ออกจากระบบหรือถอนการติดตั้ง: ลบ token และ client ทั้งหมดของ server นี้
#[tauri::command]
async fn mcp_oauth_logout(key: String) -> Result<(), String> {
    oauth_cancel_pending(&key);
    tokio::task::spawn_blocking(move || with_oauth_lock(&key, || oauth_delete(&CredentialStore, &key)))
        .await
        .map_err(|e| e.to_string())?
}

/// สถานะการล็อกอินของ server กับ URL นี้ — ไม่มี token ในคำตอบ
#[tauri::command]
async fn mcp_oauth_status(key: String, url: String) -> Result<OauthStatus, String> {
    tokio::task::spawn_blocking(move || {
        validate_oauth_key(&key)?;
        oauth_status_of(&CredentialStore, &key, &expand_env(&url))
    })
    .await
    .map_err(|e| e.to_string())?
}

// 6.x web_fetch: อ่านหน้าเว็บ (เอกสาร, changelog, issue) ให้ agent — ผ่าน Rust จึงไม่ติด CORS
const WEB_FETCH_MAX_BYTES: usize = 3 * 1024 * 1024;
const WEB_FETCH_MAX_REDIRECTS: usize = 5;

#[derive(Serialize)]
struct WebPage {
    /// URL สุดท้ายหลังตาม redirect ภายในโดเมนเดียวกัน
    url: String,
    status: u16,
    content_type: String,
    title: Option<String>,
    /// HTML ถูกแปลงเป็นข้อความ (ลิงก์อยู่ท้ายเป็น footnote)
    content: String,
    /// body ใหญ่เกิน WEB_FETCH_MAX_BYTES — อ่านแค่ส่วนต้น
    truncated: bool,
    /// redirect ไปโดเมนอื่น — ไม่ตามให้ เพราะผู้ใช้อนุญาตแค่โดเมนเดิม (agent ต้องขอใหม่ด้วย URL นี้)
    redirect: Option<String>,
}

fn parse_web_url(raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw.trim()).map_err(|e| format!("URL ไม่ถูกต้อง: {}", e))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("web_fetch รองรับเฉพาะ http:// และ https://".to_string());
    }
    if url.host_str().is_none() {
        return Err("URL ไม่มีชื่อโดเมน".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URL ต้องไม่มีชื่อผู้ใช้หรือรหัสผ่าน".to_string());
    }
    Ok(url)
}

fn is_text_content_type(content_type: &str) -> bool {
    content_type.starts_with("text/")
        || ["json", "xml", "javascript", "yaml", "toml"].iter().any(|t| content_type.contains(t))
}

/// server ไม่บอก content-type — เดาจากเนื้อหา
fn looks_like_html(body: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&body[..body.len().min(1024)]).to_lowercase();
    let head = head.trim_start_matches('\u{feff}').trim_start();
    head.starts_with("<!doctype html") || head.starts_with("<html") || (head.starts_with('<') && head.contains("<body"))
}

fn decode_basic_entities(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

fn html_title(html: &str) -> Option<String> {
    let re = regex::Regex::new(r"(?is)<title[^>]*>(.*?)</title>").ok()?;
    let raw = re.captures(html)?.get(1)?.as_str();
    let title = decode_basic_entities(&raw.split_whitespace().collect::<Vec<_>>().join(" "));
    (!title.is_empty()).then_some(title)
}

/// ยุบบรรทัดว่างที่ติดกันเกิน 1 บรรทัด และตัดช่องว่างท้ายบรรทัด (หน้าเว็บมี layout ว่าง ๆ เยอะ)
fn tidy_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blank_run = 0;
    for line in text.lines() {
        let line = line.trim_end();
        blank_run = if line.is_empty() { blank_run + 1 } else { 0 };
        if blank_run <= 1 {
            out.push_str(line);
            out.push('\n');
        }
    }
    out.trim().to_string()
}

fn page_from_body(url: String, status: u16, content_type: &str, body: &[u8], truncated: bool) -> Result<WebPage, String> {
    let is_html = content_type.contains("html") || (content_type.is_empty() && looks_like_html(body));
    let (title, content) = if is_html {
        let html = String::from_utf8_lossy(body);
        let text = html2text::config::plain()
            .no_link_wrapping()
            .allow_width_overflow()
            .string_from_read(body, 120)
            .unwrap_or_else(|_| html.to_string());
        (html_title(&html), tidy_text(&text))
    } else if is_text_content_type(content_type) || (content_type.is_empty() && !body.contains(&0)) {
        (None, String::from_utf8_lossy(body).into_owned())
    } else {
        return Err(format!(
            "web_fetch อ่านได้เฉพาะหน้าเว็บและไฟล์ข้อความ — URL นี้เป็น {}",
            if content_type.is_empty() { "ไฟล์ binary" } else { content_type }
        ));
    };
    let content_type = if content_type.is_empty() && is_html { "text/html".to_string() } else { content_type.to_string() };
    Ok(WebPage { url, status, content_type, title, content, truncated, redirect: None })
}

fn fetch_web_page(raw_url: &str) -> Result<WebPage, String> {
    use std::io::Read;
    let mut url = parse_web_url(raw_url)?;
    // ตาม redirect เอง: ไปต่อเฉพาะโดเมนเดิม (ผู้ใช้อนุญาตเป็นรายโดเมน)
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(30))
        .redirects(0)
        .user_agent("Mozilla/5.0 (compatible; Dex-Agent/0.1)")
        .build();
    for _ in 0..=WEB_FETCH_MAX_REDIRECTS {
        let resp = match agent
            .get(url.as_str())
            .set("Accept", "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.9,*/*;q=0.5")
            .call()
        {
            Ok(r) => r,
            // 404/500 ก็อ่าน body ด้วย — หน้า error มักบอกว่าผิดตรงไหน
            Err(ureq::Error::Status(_, r)) => r,
            Err(e) => return Err(format!("เชื่อมต่อไม่สำเร็จ: {}", e)),
        };
        let status = resp.status();
        if (300..400).contains(&status) {
            let location = resp.header("location").ok_or_else(|| format!("HTTP {} แต่ไม่มี Location", status))?;
            let next = url.join(location).map_err(|e| format!("redirect ไม่ถูกต้อง: {}", e))?;
            if next.host_str() != url.host_str() || !matches!(next.scheme(), "http" | "https") {
                return Ok(WebPage {
                    url: url.to_string(),
                    status,
                    content_type: String::new(),
                    title: None,
                    content: String::new(),
                    truncated: false,
                    redirect: Some(next.to_string()),
                });
            }
            url = next;
            continue;
        }
        let content_type = if resp.header("content-type").is_some() { resp.content_type().to_lowercase() } else { String::new() };
        let mut body = Vec::new();
        resp.into_reader()
            .take(WEB_FETCH_MAX_BYTES as u64 + 1)
            .read_to_end(&mut body)
            .map_err(|e| format!("อ่านหน้าเว็บไม่สำเร็จ: {}", e))?;
        let truncated = body.len() > WEB_FETCH_MAX_BYTES;
        body.truncate(WEB_FETCH_MAX_BYTES);
        return page_from_body(url.to_string(), status, &content_type, &body, truncated);
    }
    Err(format!("redirect เกิน {} ครั้ง", WEB_FETCH_MAX_REDIRECTS))
}

#[tauri::command]
async fn web_fetch(url: String) -> Result<WebPage, String> {
    tokio::task::spawn_blocking(move || fetch_web_page(&url))
        .await
        .map_err(|e| e.to_string())?
}

// 7.1 API key เก็บใน Windows Credential Manager (เข้ารหัสด้วยบัญชีผู้ใช้ของ Windows) แทน localStorage
const KEYRING_SERVICE: &str = "com.thegrace.dex";

/// ชื่อ provider ใช้เป็นชื่อ credential — จำกัดตัวอักษรกันชื่อแปลก ๆ
fn valid_provider_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn keyring_entry(provider: &str) -> Result<keyring::Entry, String> {
    if !valid_provider_id(provider) {
        return Err(format!("ชื่อ provider ไม่ถูกต้อง: {}", provider));
    }
    keyring::Entry::new(KEYRING_SERVICE, provider).map_err(|e| format!("เปิด Credential Manager ไม่สำเร็จ: {}", e))
}

#[tauri::command]
fn load_api_keys(providers: Vec<String>) -> Result<HashMap<String, String>, String> {
    let mut keys = HashMap::new();
    for provider in providers {
        match keyring_entry(&provider)?.get_password() {
            Ok(key) => {
                keys.insert(provider, key);
            }
            Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(format!("อ่าน API key ของ {} ไม่สำเร็จ: {}", provider, e)),
        }
    }
    Ok(keys)
}

/// key ว่าง = ลบ credential ทิ้ง
#[tauri::command]
fn save_api_key(provider: String, key: String) -> Result<(), String> {
    let entry = keyring_entry(&provider)?;
    let key = key.trim();
    if key.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("ลบ API key ของ {} ไม่สำเร็จ: {}", provider, e)),
        };
    }
    entry
        .set_password(key)
        .map_err(|e| format!("บันทึก API key ของ {} ไม่สำเร็จ: {}", provider, e))
}

// 7.2 ข้อมูลของแต่ละแชทเก็บเป็นไฟล์ใน app data (localStorage จุได้แค่ ~5 MB และเขียนพลาดแบบเงียบ ๆ)
// - history/<id>.json  ประวัติแบบ native ของ agent (รวม tool call/result, thinking) ให้ agent จำได้ว่าเคยอ่าน/แก้อะไรไป
// - chats/<id>.json    ข้อความที่หน้าจอแชทแสดง (ChatSession)
const HISTORY_DIR: &str = "history";
const CHATS_DIR: &str = "chats";

fn app_data_subdir(app: &AppHandle, folder: &str) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("หาโฟลเดอร์ข้อมูลแอปไม่เจอ: {}", e))?
        .join(folder))
}

fn session_file_path(app: &AppHandle, folder: &str, session_id: &str) -> Result<PathBuf, String> {
    if !valid_provider_id(session_id) {
        return Err(format!("session id ไม่ถูกต้อง: {}", session_id));
    }
    Ok(app_data_subdir(app, folder)?.join(format!("{}.json", session_id)))
}

fn save_session_file(app: &AppHandle, folder: &str, session_id: &str, data: &str) -> Result<(), String> {
    let path = session_file_path(app, folder, session_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("สร้างโฟลเดอร์ไม่สำเร็จ: {}", e))?;
    }
    write_atomic(&path, data.as_bytes()).map_err(|e| format!("บันทึกไม่สำเร็จ: {}", e))
}

fn delete_session_file(app: &AppHandle, folder: &str, session_id: &str) -> Result<(), String> {
    let path = session_file_path(app, folder, session_id)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("ลบไม่สำเร็จ: {}", e)),
    }
}

/// เนื้อหาของไฟล์ .json ทุกไฟล์ในโฟลเดอร์ (ไม่มีโฟลเดอร์ = ว่าง) — ไฟล์ที่อ่านไม่ได้ถูกข้าม ไม่ให้ไฟล์เสียไฟล์เดียวทำแชททั้งหมดหาย
fn read_json_files(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .filter_map(|p| fs::read_to_string(&p).ok())
        .collect()
}

#[tauri::command]
fn save_session_history(app: AppHandle, session_id: String, data: String) -> Result<(), String> {
    save_session_file(&app, HISTORY_DIR, &session_id, &data)
}

#[tauri::command]
fn load_session_history(app: AppHandle, session_id: String) -> Result<Option<String>, String> {
    let path = session_file_path(&app, HISTORY_DIR, &session_id)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("อ่านประวัติไม่สำเร็จ: {}", e)),
    }
}

#[tauri::command]
fn delete_session_history(app: AppHandle, session_id: String) -> Result<(), String> {
    delete_session_file(&app, HISTORY_DIR, &session_id)
}

// async = ไม่รันบน main thread — แชทยาว ๆ เป็นไฟล์หลาย MB และถูกบันทึกถี่ระหว่างสตรีม
#[tauri::command]
async fn save_chat_session(app: AppHandle, session_id: String, data: String) -> Result<(), String> {
    save_session_file(&app, CHATS_DIR, &session_id, &data)
}

#[tauri::command]
async fn load_chat_sessions(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(read_json_files(&app_data_subdir(&app, CHATS_DIR)?))
}

#[tauri::command]
async fn delete_chat_session(app: AppHandle, session_id: String) -> Result<(), String> {
    delete_session_file(&app, CHATS_DIR, &session_id)
}

// 7.3 checkpoint ของแต่ละเทิร์น (เนื้อหาไฟล์ก่อน agent แก้) — checkpoints/<session>/<message>.json
// แยกไฟล์ต่อเทิร์น: เทิร์นที่แก้หลายไฟล์ถูกเขียนซ้ำเฉพาะของตัวเอง และลบทั้งแชทได้ด้วยการลบโฟลเดอร์เดียว
const CHECKPOINTS_DIR: &str = "checkpoints";

fn checkpoint_dir(root: &Path, session_id: &str) -> Result<PathBuf, String> {
    if !valid_provider_id(session_id) {
        return Err(format!("session id ไม่ถูกต้อง: {}", session_id));
    }
    Ok(root.join(session_id))
}

fn checkpoint_path(root: &Path, session_id: &str, message_id: &str) -> Result<PathBuf, String> {
    if !valid_provider_id(message_id) {
        return Err(format!("message id ไม่ถูกต้อง: {}", message_id));
    }
    Ok(checkpoint_dir(root, session_id)?.join(format!("{}.json", message_id)))
}

fn write_checkpoint(root: &Path, session_id: &str, message_id: &str, data: &str) -> Result<(), String> {
    let path = checkpoint_path(root, session_id, message_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("สร้างโฟลเดอร์ไม่สำเร็จ: {}", e))?;
    }
    write_atomic(&path, data.as_bytes()).map_err(|e| format!("บันทึก checkpoint ไม่สำเร็จ: {}", e))
}

fn remove_checkpoint(root: &Path, session_id: &str, message_id: &str) -> Result<(), String> {
    match fs::remove_file(checkpoint_path(root, session_id, message_id)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("ลบ checkpoint ไม่สำเร็จ: {}", e)),
    }
}

fn remove_checkpoints(root: &Path, session_id: &str) -> Result<(), String> {
    match fs::remove_dir_all(checkpoint_dir(root, session_id)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("ลบ checkpoint ไม่สำเร็จ: {}", e)),
    }
}

// async = ไม่รันบน main thread — checkpoint หนึ่งเทิร์นอาจมีเนื้อหาไฟล์หลาย MB
#[tauri::command]
async fn save_checkpoint(app: AppHandle, session_id: String, message_id: String, data: String) -> Result<(), String> {
    write_checkpoint(&app_data_subdir(&app, CHECKPOINTS_DIR)?, &session_id, &message_id, &data)
}

#[tauri::command]
async fn load_checkpoints(app: AppHandle, session_id: String) -> Result<Vec<String>, String> {
    Ok(read_json_files(&checkpoint_dir(&app_data_subdir(&app, CHECKPOINTS_DIR)?, &session_id)?))
}

#[tauri::command]
async fn delete_checkpoint(app: AppHandle, session_id: String, message_id: String) -> Result<(), String> {
    remove_checkpoint(&app_data_subdir(&app, CHECKPOINTS_DIR)?, &session_id, &message_id)
}

#[tauri::command]
async fn delete_checkpoints(app: AppHandle, session_id: String) -> Result<(), String> {
    remove_checkpoints(&app_data_subdir(&app, CHECKPOINTS_DIR)?, &session_id)
}

// 8. เปิดหน้าต่างเลือกโฟลเดอร์แบบ Native บน Windows
// เป็น async command: คำสั่ง sync ของ Tauri รันบน main thread ซึ่งจะทำให้ UI ค้างตลอดเวลาที่ dialog เปิดอยู่
#[tauri::command]
async fn select_folder() -> Result<Option<String>, String> {
    let script = r#"
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = "เลือกโฟลเดอร์ Workspace สำหรับ Dex Agent"
        $dialog.ShowNewFolderButton = $true
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
            Write-Output $dialog.SelectedPath
        }
    "#;
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-STA", "-Command", script]);

    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("เปิดกล่องเลือกโฟลเดอร์ไม่สำเร็จ: {}", e))?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(if path.is_empty() { None } else { Some(path) })
}

// 9. Browser pane: child webview ในหน้าต่างหลัก ให้ agent เปิดเว็บ (เช่น dev server) แล้วทดสอบเอง
// คุมผ่าน DevTools protocol ของ WebView2 — หน้าเว็บใน pane เป็น origin ภายนอก Tauri จึงไม่ให้เรียกคำสั่งของแอป
// ยกเว้นหน้าของตัวแอปเอง (devUrl / *.localhost) ที่ Tauri ถือเป็น origin ภายใน — จึงห้ามเปิดหน้าเหล่านั้นใน pane
// 7.x G-docx: เว็บแอปแก้ไฟล์ Word ที่ฝังมากับ Dex เปิดใน browser pane แล้วให้ tool `docx` สั่งงาน
// ต้องเสิร์ฟจาก origin ธรรมดา ไม่ใช่ของแอป: หน้าใน pane ต้องไม่ได้สิทธิ์เรียกคำสั่งของ Tauri (ดู is_app_url)
static GDOCX_FILES: include_dir::Dir<'static> = include_dir::include_dir!("$CARGO_MANIFEST_DIR/../plugins/gdocx");
/// พอร์ตคงที่ให้ค่าที่ G-docx จำไว้ (origin เดิม) อยู่ข้ามการเปิดแอป — ถ้าไม่ว่างค่อยให้ระบบเลือก
const GDOCX_PORT: u16 = 17420;
static GDOCX_SERVER: std::sync::OnceLock<Result<u16, String>> = std::sync::OnceLock::new();

/// เอกสารใน pane เป็นข้อมูลที่ไม่น่าเชื่อถือ: ถึงมีช่องโหว่ใน reader ก็ส่งเนื้อหาออกเน็ตหรือโหลดของนอกไม่ได้
const GDOCX_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:; media-src 'self' blob:; form-action 'none'; base-uri 'none'";

/// เฉพาะไฟล์ของตัวแอป — ใน submodule มีไฟล์อื่นอย่าง .git และ README ที่ไม่ต้องเสิร์ฟ
fn gdocx_file(path: &str) -> Option<&'static [u8]> {
    let allowed = path == "index.html" || ["css/", "js/", "fonts/", "vendor/"].iter().any(|dir| path.starts_with(dir));
    if !allowed {
        return None;
    }
    GDOCX_FILES.get_file(path).map(|f| f.contents())
}

/// กัน DNS rebinding ของเซิร์ฟเวอร์ใน 127.0.0.1: เว็บอื่นที่ชี้ชื่อโดเมนมาที่นี่จะส่ง Host เป็นชื่อของตัวเอง
fn http_host_ok(request: &str, port: u16) -> bool {
    let host = format!("127.0.0.1:{}", port);
    request
        .lines()
        .any(|l| l.split_once(':').is_some_and(|(k, v)| k.eq_ignore_ascii_case("host") && v.trim() == host))
}

/// คืน (สถานะ, content type, เนื้อหา) — แยกจาก socket เพื่อให้เทสต์ได้
fn gdocx_response(request: &str, port: u16) -> (&'static str, &'static str, &'static [u8]) {
    let mut parts = request.lines().next().unwrap_or("").split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    if method != "GET" && method != "HEAD" {
        return ("405 Method Not Allowed", "text/plain", b"method not allowed");
    }
    if !http_host_ok(request, port) {
        return ("403 Forbidden", "text/plain", b"forbidden");
    }
    let path = target.split(['?', '#']).next().unwrap_or("").trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let content_type = match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };
    match gdocx_file(path) {
        Some(body) => ("200 OK", content_type, body),
        None => ("404 Not Found", "text/plain", b"not found"),
    }
}

/// อ่าน request หนึ่งตัวจาก socket แล้วตอบด้วยผลของ `respond` (เซิร์ฟเวอร์ของ G-docx และ Dex Design)
fn http_serve<B: AsRef<[u8]>>(
    mut stream: std::net::TcpStream,
    csp: &str,
    respond: impl FnOnce(&str) -> (&'static str, &'static str, B),
) -> std::io::Result<()> {
    use std::io::{Read, Write};
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut buf = [0u8; 8192];
    let mut len = 0;
    while len < buf.len() && !buf[..len].windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut buf[len..])?;
        if n == 0 {
            break;
        }
        len += n;
    }
    let request = String::from_utf8_lossy(&buf[..len]);
    let (status, content_type, body) = respond(&request);
    let body = body.as_ref();
    let head = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nContent-Security-Policy: {}\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        status,
        content_type,
        body.len(),
        csp
    );
    stream.write_all(head.as_bytes())?;
    if !request.starts_with("HEAD") {
        stream.write_all(body)?;
    }
    Ok(())
}

fn gdocx_start_server() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", GDOCX_PORT))
        .or_else(|_| std::net::TcpListener::bind(("127.0.0.1", 0)))
        .map_err(|e| format!("เปิด G-docx ไม่สำเร็จ: {}", e))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let _ = http_serve(stream, GDOCX_CSP, |request| gdocx_response(request, port));
            });
        }
    });
    Ok(port)
}

/// URL ของ G-docx ในเครื่อง (เปิดเซิร์ฟเวอร์ตอนใช้ครั้งแรก)
#[tauri::command]
fn gdocx_url() -> Result<String, String> {
    let port = GDOCX_SERVER.get_or_init(gdocx_start_server).clone()?;
    Ok(format!("http://127.0.0.1:{}/index.html?embedded", port))
}

// 7.y Dex Design: โปรเจกต์ดีไซน์อยู่ที่ <workspace>/.dex/designs/<id>/ และเปิดใน browser pane
// เสิร์ฟจาก origin ธรรมดาเหมือน G-docx — HTML ที่ AI เขียนต้องไม่ได้สิทธิ์เรียกคำสั่งของ Tauri (ดู is_app_url)
const DESIGNS_DIR: &str = ".dex/designs";
const DESIGN_META_FILE: &str = "design.json";
/// ไฟล์ของแอปในโปรเจกต์ ไม่ใช่ส่วนของดีไซน์: ไม่เข้าเวอร์ชัน ไม่ถูก export และไม่เสิร์ฟ
const DESIGN_APP_FILES: [&str; 2] = [DESIGN_META_FILE, "comments.json"];
const DESIGN_VERSIONS_DIR: &str = ".versions";
const DESIGN_VERSIONS_INDEX: &str = "index.json";
const DESIGN_COMPARE_PAGE: &str = "__compare";
const DESIGN_MAX_VERSIONS: usize = 30;

static DESIGN_SERVER: std::sync::OnceLock<Result<u16, String>> = std::sync::OnceLock::new();
/// token ใน URL → โฟลเดอร์ของโปรเจกต์ (สุ่มใหม่ทุกครั้งที่เปิดแอป โปรแกรมอื่นในเครื่องเดา URL ไม่ได้)
static DESIGN_ROOTS: std::sync::LazyLock<Mutex<HashMap<String, PathBuf>>> = std::sync::LazyLock::new(Default::default);

/// หน้าดีไซน์รัน script ของตัวเองและโหลดฟอนต์/ไลบรารีจาก CDN ได้ แต่ส่งข้อมูลออกด้วย fetch หรือ form ไม่ได้
const DESIGN_CSP: &str = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; img-src 'self' data: blob: https:; font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net; media-src 'self' data: blob: https:; connect-src 'self'; form-action 'none'; base-uri 'self'";

#[derive(Serialize, Deserialize)]
struct DesignMeta {
    title: String,
    created_at: u64,
}

#[derive(Serialize, Deserialize, Clone)]
struct DesignVersion {
    version: u32,
    summary: String,
    at: u64,
}

#[derive(Serialize)]
struct DesignInfo {
    id: String,
    title: String,
    created_at: u64,
    updated_at: u64,
    /// เวอร์ชันล่าสุด (0 = ยังไม่มี)
    version: u32,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn is_design_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// ส่วนของพาธที่เสิร์ฟได้ — ไม่ต้องถอด %xx และตัด `..`, dotfile, ตัวคั่นแบบ Windows ทิ้งไปในตัว
fn is_design_segment(segment: &str) -> bool {
    !segment.is_empty()
        && !segment.starts_with('.')
        && segment.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn design_slug(title: &str) -> String {
    let mut slug = String::new();
    for c in title.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    slug.truncate(40);
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() { "design".to_string() } else { slug.to_string() }
}

fn design_dir(workspace: Option<&str>, id: &str) -> Result<PathBuf, String> {
    if !is_design_id(id) {
        return Err(format!("ชื่อโปรเจกต์ดีไซน์ไม่ถูกต้อง: {}", id));
    }
    let dir = validate_workspace_path(&format!("{}/{}", DESIGNS_DIR, id), workspace)?;
    if dir.is_dir() { Ok(dir) } else { Err(format!("ไม่พบโปรเจกต์ดีไซน์: {}", id)) }
}

/// ไฟล์ของดีไซน์ (พาธสัมพัทธ์) — ไม่รวมไฟล์ของแอป, dotfile และ symlink ที่อาจชี้ออกนอกโปรเจกต์
fn design_files(root: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, rel: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_text = name.to_string_lossy();
            if name_text.starts_with('.') || (rel.as_os_str().is_empty() && DESIGN_APP_FILES.contains(&&*name_text)) {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                walk(&entry.path(), &rel.join(&name), out);
            } else if kind.is_file() {
                out.push(rel.join(&name));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, Path::new(""), &mut out);
    out.sort();
    out
}

fn design_copy_files(from: &Path, to: &Path) -> Result<(), String> {
    for rel in design_files(from) {
        let target = to.join(&rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("สร้างโฟลเดอร์ไม่สำเร็จ: {}", e))?;
        }
        fs::copy(from.join(&rel), &target).map_err(|e| format!("คัดลอก {} ไม่สำเร็จ: {}", rel.display(), e))?;
    }
    Ok(())
}

fn design_same_files(a: &Path, b: &Path) -> bool {
    let files = design_files(a);
    files == design_files(b)
        && files.iter().all(|rel| match (fs::read(a.join(rel)), fs::read(b.join(rel))) {
            (Ok(x), Ok(y)) => x == y,
            _ => false,
        })
}

fn design_read_versions(root: &Path) -> Vec<DesignVersion> {
    fs::read_to_string(root.join(DESIGN_VERSIONS_DIR).join(DESIGN_VERSIONS_INDEX))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// เก็บสภาพปัจจุบันเป็นเวอร์ชันใหม่ — ไฟล์ไม่ต่างจากเวอร์ชันล่าสุดก็คืนเวอร์ชันเดิม
fn design_commit_files(root: &Path, summary: &str) -> Result<DesignVersion, String> {
    let versions_dir = root.join(DESIGN_VERSIONS_DIR);
    let mut versions = design_read_versions(root);
    if let Some(last) = versions.last() {
        if design_same_files(root, &versions_dir.join(last.version.to_string())) {
            return Ok(last.clone());
        }
    }
    let entry = DesignVersion {
        version: versions.last().map(|v| v.version).unwrap_or(0) + 1,
        summary: summary.trim().chars().take(200).collect(),
        at: now_ms(),
    };
    let snapshot = versions_dir.join(entry.version.to_string());
    fs::create_dir_all(&snapshot).map_err(|e| format!("บันทึกเวอร์ชันไม่สำเร็จ: {}", e))?;
    design_copy_files(root, &snapshot)?;
    versions.push(entry.clone());
    while versions.len() > DESIGN_MAX_VERSIONS {
        let oldest = versions.remove(0);
        let _ = fs::remove_dir_all(versions_dir.join(oldest.version.to_string()));
    }
    let index = serde_json::to_string_pretty(&versions).map_err(|e| e.to_string())?;
    write_atomic(&versions_dir.join(DESIGN_VERSIONS_INDEX), index.as_bytes()).map_err(|e| format!("บันทึกเวอร์ชันไม่สำเร็จ: {}", e))?;
    Ok(entry)
}

/// เอาเวอร์ชันเก่ากลับมา — สภาพปัจจุบันถูกเก็บเป็นเวอร์ชันไว้ก่อนเสมอ จึงย้อนกลับได้อีก
fn design_restore_files(root: &Path, version: u32) -> Result<DesignVersion, String> {
    let source = root.join(DESIGN_VERSIONS_DIR).join(version.to_string());
    if !source.is_dir() {
        return Err(format!("ไม่พบเวอร์ชัน {}", version));
    }
    design_commit_files(root, &format!("Before restoring v{}", version))?;
    for rel in design_files(root) {
        fs::remove_file(root.join(&rel)).map_err(|e| format!("ลบ {} ไม่สำเร็จ: {}", rel.display(), e))?;
    }
    design_copy_files(&source, root)?;
    design_commit_files(root, &format!("Restored v{}", version))
}

fn design_info(root: &Path, id: &str) -> Option<DesignInfo> {
    let meta: DesignMeta = serde_json::from_str(&fs::read_to_string(root.join(DESIGN_META_FILE)).ok()?).ok()?;
    let last = design_read_versions(root).pop();
    Some(DesignInfo {
        id: id.to_string(),
        title: meta.title,
        created_at: meta.created_at,
        updated_at: last.as_ref().map(|v| v.at).unwrap_or(meta.created_at),
        version: last.map(|v| v.version).unwrap_or(0),
    })
}

#[tauri::command]
async fn design_list(workspace: Option<String>) -> Result<Vec<DesignInfo>, String> {
    let dir = validate_workspace_path(DESIGNS_DIR, workspace.as_deref())?;
    let Ok(entries) = fs::read_dir(&dir) else { return Ok(Vec::new()) };
    let mut list: Vec<DesignInfo> = entries
        .flatten()
        .filter_map(|e| design_info(&e.path(), &e.file_name().to_string_lossy()))
        .filter(|info| is_design_id(&info.id))
        .collect();
    list.sort_by_key(|info| std::cmp::Reverse(info.updated_at));
    Ok(list)
}

#[tauri::command]
async fn design_create(workspace: Option<String>, title: String) -> Result<DesignInfo, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("ต้องตั้งชื่อโปรเจกต์ดีไซน์".to_string());
    }
    let parent = validate_workspace_path(DESIGNS_DIR, workspace.as_deref())?;
    let slug = design_slug(title);
    let id = (1..)
        .map(|n| if n == 1 { slug.clone() } else { format!("{}-{}", slug, n) })
        .find(|candidate| !parent.join(candidate).exists())
        .unwrap();
    let root = parent.join(&id);
    fs::create_dir_all(&root).map_err(|e| format!("สร้างโปรเจกต์ไม่สำเร็จ: {}", e))?;
    let meta = serde_json::to_string_pretty(&DesignMeta { title: title.to_string(), created_at: now_ms() }).map_err(|e| e.to_string())?;
    write_atomic(&root.join(DESIGN_META_FILE), meta.as_bytes()).map_err(|e| format!("สร้างโปรเจกต์ไม่สำเร็จ: {}", e))?;
    // สำเนาเวอร์ชันเก่าไม่ต้องเข้า git ของผู้ใช้
    write_atomic(&root.join(".gitignore"), format!("{}/\n", DESIGN_VERSIONS_DIR).as_bytes()).map_err(|e| format!("สร้างโปรเจกต์ไม่สำเร็จ: {}", e))?;
    design_info(&root, &id).ok_or_else(|| "สร้างโปรเจกต์ไม่สำเร็จ".to_string())
}

#[tauri::command]
async fn design_commit(workspace: Option<String>, id: String, summary: String) -> Result<DesignVersion, String> {
    design_commit_files(&design_dir(workspace.as_deref(), &id)?, &summary)
}

#[tauri::command]
async fn design_versions(workspace: Option<String>, id: String) -> Result<Vec<DesignVersion>, String> {
    Ok(design_read_versions(&design_dir(workspace.as_deref(), &id)?))
}

#[tauri::command]
async fn design_restore(workspace: Option<String>, id: String, version: u32) -> Result<DesignVersion, String> {
    design_restore_files(&design_dir(workspace.as_deref(), &id)?, version)
}

/// คัดลอกไฟล์ดีไซน์ไปโฟลเดอร์ที่ผู้ใช้เลือกจากกล่อง dialog (อยู่นอก workspace ได้) ไม่ทับของเดิม
#[tauri::command]
async fn design_export(workspace: Option<String>, id: String, destination: String) -> Result<String, String> {
    let root = design_dir(workspace.as_deref(), &id)?;
    let parent = PathBuf::from(destination);
    if !parent.is_dir() {
        return Err("ไม่พบโฟลเดอร์ปลายทาง".to_string());
    }
    let target = (1..)
        .map(|n| parent.join(if n == 1 { id.clone() } else { format!("{}-{}", id, n) }))
        .find(|candidate| !candidate.exists())
        .unwrap();
    design_copy_files(&root, &target)?;
    Ok(target.to_string_lossy().to_string())
}

/// URL ของหน้าดีไซน์ — `version` ว่าง = สภาพปัจจุบัน
#[tauri::command]
async fn design_preview_url(workspace: Option<String>, id: String, version: Option<u32>, page: Option<String>) -> Result<String, String> {
    let root = fs::canonicalize(design_dir(workspace.as_deref(), &id)?).map_err(|e| e.to_string())?;
    let page = page.filter(|p| !p.trim().is_empty()).unwrap_or_else(|| "index.html".to_string());
    if !page.split('/').all(is_design_segment) {
        return Err(format!("ชื่อหน้าไม่ถูกต้อง: {}", page));
    }
    let prefix = version.map(|v| format!("{}/{}/", DESIGN_VERSIONS_DIR, v)).unwrap_or_default();
    if !root.join(&prefix).join(&page).is_file() {
        return Err(format!("โปรเจกต์นี้ยังไม่มีไฟล์ {}{}", prefix, page));
    }
    let port = DESIGN_SERVER.get_or_init(design_start_server).clone()?;
    let mut roots = DESIGN_ROOTS.lock().unwrap();
    let token = match roots.iter().find(|(_, r)| **r == root) {
        Some((token, _)) => token.clone(),
        None => {
            let token = uuid::Uuid::new_v4().simple().to_string();
            roots.insert(token.clone(), root);
            token
        }
    };
    Ok(format!("http://127.0.0.1:{}/{}/{}{}", port, token, prefix, page))
}

/// หน้าเทียบหลายแบบ: ทุกไฟล์ HTML ที่รากโปรเจกต์ใน iframe วางเคียงกัน ย่อให้พอดีช่อง
/// ชื่อไฟล์ผ่าน is_design_segment แล้ว (ตัวอักษรปลอดภัย) และความกว้างเป็นตัวเลข จึงใส่ลง HTML ได้ตรง ๆ
fn design_compare_page(root: &Path, target: &str) -> String {
    let width = target
        .split_once('?')
        .and_then(|(_, query)| query.split('&').find_map(|pair| pair.strip_prefix("width=")))
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(1440)
        .clamp(200, 3000);
    let mut pages: Vec<String> = design_files(root)
        .iter()
        .filter(|rel| rel.components().count() == 1)
        .map(|rel| rel.to_string_lossy().to_string())
        .filter(|name| is_design_segment(name) && (name.to_ascii_lowercase().ends_with(".html") || name.to_ascii_lowercase().ends_with(".htm")))
        .collect();
    pages.sort_by_key(|name| name != "index.html");
    let cells: String = pages
        .iter()
        .map(|name| format!(r#"<figure><figcaption>{0}</figcaption><div class="f"><iframe src="{0}" title="{0}"></iframe></div></figure>"#, name))
        .collect();
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>Compare</title><style>
html,body{{margin:0;height:100%;background:#2a2926}}
body{{display:grid;grid-template-columns:repeat(var(--cols),1fr);gap:12px;padding:12px;box-sizing:border-box;overflow-y:auto}}
figure{{margin:0;min-width:0;display:flex;flex-direction:column;gap:8px}}
figcaption{{color:#e8e4da;font:600 26px/1.3 system-ui,sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
.f{{overflow:hidden;background:#fff;border-radius:8px}}
iframe{{display:block;border:0;transform-origin:0 0}}
</style></head><body>{cells}<script>
const WIDTH={width};
const COUNT=document.querySelectorAll('figure').length;
const COLS=Math.max(1,Math.min(COUNT,4));
document.body.style.setProperty('--cols',COLS);
function fit(){{
  const cellWidth=(document.documentElement.clientWidth-24-12*(COLS-1))/COLS;
  const cellHeight=Math.max(200,innerHeight-24-44);
  const scale=cellWidth/WIDTH;
  for(const box of document.querySelectorAll('.f')){{
    box.style.width=cellWidth+'px';
    box.style.height=cellHeight+'px';
    const frame=box.firstElementChild;
    frame.style.width=WIDTH+'px';
    frame.style.height=(cellHeight/scale)+'px';
    frame.style.transform='scale('+scale+')';
  }}
}}
addEventListener('resize',fit);
fit();
</script></body></html>"#
    )
}

/// คืน (สถานะ, content type, เนื้อหา) — แยกจาก socket เพื่อให้เทสต์ได้
fn design_response(request: &str, port: u16, root_of: impl Fn(&str) -> Option<PathBuf>) -> (&'static str, &'static str, Vec<u8>) {
    let not_found = || ("404 Not Found", "text/plain", b"not found".to_vec());
    let mut parts = request.lines().next().unwrap_or("").split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    if method != "GET" && method != "HEAD" {
        return ("405 Method Not Allowed", "text/plain", b"method not allowed".to_vec());
    }
    if !http_host_ok(request, port) {
        return ("403 Forbidden", "text/plain", b"forbidden".to_vec());
    }
    let path = target.split(['?', '#']).next().unwrap_or("").trim_start_matches('/');
    let mut segments: Vec<&str> = path.split('/').collect();
    let Some(root) = root_of(segments.remove(0)) else { return not_found() };
    let mut file = root.clone();
    // dotfile เดียวที่เปิดได้: สำเนาเวอร์ชันเก่า .versions/<เลข>/
    if segments.first() == Some(&DESIGN_VERSIONS_DIR) {
        match segments.get(1) {
            Some(n) if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) => file = file.join(DESIGN_VERSIONS_DIR).join(n),
            _ => return not_found(),
        }
        segments.drain(..2);
    } else if segments == [DESIGN_COMPARE_PAGE] {
        return ("200 OK", "text/html; charset=utf-8", design_compare_page(&root, target).into_bytes());
    } else if segments.len() == 1 && DESIGN_APP_FILES.contains(&segments[0]) {
        return not_found();
    }
    if segments.is_empty() || segments == [""] {
        segments = vec!["index.html"];
    }
    if !segments.iter().all(|s| is_design_segment(s)) {
        return not_found();
    }
    let name = segments[segments.len() - 1];
    if is_sensitive_name(name) {
        return not_found();
    }
    let content_type = match name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "txt" | "md" => "text/plain; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => return not_found(),
    };
    for segment in &segments {
        file.push(segment);
    }
    // canonicalize ตาม symlink แล้วเทียบอีกที กันลิงก์ในโปรเจกต์ที่ชี้ออกไปนอก
    let Ok(real) = fs::canonicalize(&file) else { return not_found() };
    if !is_within(&real, &root) || !real.is_file() {
        return not_found();
    }
    match fs::read(&real) {
        Ok(body) => ("200 OK", content_type, body),
        Err(_) => not_found(),
    }
}

fn design_start_server() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("เปิดเซิร์ฟเวอร์ของ Dex Design ไม่สำเร็จ: {}", e))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let _ = http_serve(stream, DESIGN_CSP, |request| {
                    design_response(request, port, |token| DESIGN_ROOTS.lock().unwrap().get(token).cloned())
                });
            });
        }
    });
    Ok(port)
}

const BROWSER_LABEL: &str = "dex-browser";

/// method ของ DevTools protocol ที่ UI เรียกได้ — ไม่เปิดทั้งหมด (Network/Storage/Target ฯลฯ)
const BROWSER_CDP_METHODS: &[&str] = &[
    "Runtime.evaluate",
    "Emulation.setDeviceMetricsOverride",
    "Emulation.clearDeviceMetricsOverride",
    "Page.captureScreenshot",
    "Page.reload",
    "Page.getNavigationHistory",
    "Page.navigateToHistoryEntry",
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
    "Input.insertText",
];

/// ตำแหน่งของ pane ในหน้าต่าง (CSS px ของหน้าแอป = logical px)
#[derive(Deserialize, Clone, Copy)]
struct PaneBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Serialize, Clone)]
struct BrowserEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    loading: Option<bool>,
}

/// URL ที่ Tauri จะถือว่าเป็นหน้าของแอปเอง (ได้สิทธิ์เรียกคำสั่งของแอป)
fn is_app_url(dev_url: Option<&url::Url>, url: &url::Url) -> bool {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    // tauri://localhost, http://tauri.localhost, ipc/asset protocol บน Windows เป็น http://<ชื่อ>.localhost
    url.scheme() == "tauri"
        || url.scheme() == "ipc"
        || host.ends_with(".localhost")
        || dev_url.is_some_and(|dev| dev.origin() == url.origin())
}

fn browser_url_allowed(dev_url: Option<&url::Url>, url: &url::Url) -> bool {
    url.as_str() == "about:blank"
        || (matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none()
            && !is_app_url(dev_url, url))
}

fn check_browser_url(app: &AppHandle, raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw.trim()).map_err(|e| format!("URL ไม่ถูกต้อง: {}", e))?;
    if browser_url_allowed(app.config().build.dev_url.as_ref(), &url) {
        Ok(url)
    } else if is_app_url(app.config().build.dev_url.as_ref(), &url) {
        Err("เปิดหน้าของตัว Dex เองใน browser pane ไม่ได้".to_string())
    } else {
        Err("browser pane เปิดได้เฉพาะ http:// และ https://".to_string())
    }
}

fn browser_webview(app: &AppHandle) -> Result<tauri::Webview, String> {
    app.get_webview(BROWSER_LABEL).ok_or_else(|| "browser pane ยังไม่ได้เปิด".to_string())
}

fn apply_bounds(webview: &tauri::Webview, bounds: PaneBounds) -> Result<(), String> {
    webview
        .set_position(tauri::LogicalPosition::new(bounds.x, bounds.y))
        .and_then(|_| webview.set_size(tauri::LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0))))
        .map_err(|e| e.to_string())
}

// ทุกคำสั่งของ pane เป็น async: คำสั่ง sync รันบน main thread และการสร้าง webview จากตรงนั้นค้างบน Windows
/// `init_script` ใช้ตอนสร้าง webview ครั้งแรกเท่านั้น — รันก่อนสคริปต์ของทุกหน้า (เช่น ตัวเก็บ console ให้ agent)
#[tauri::command]
async fn browser_open(app: AppHandle, bounds: PaneBounds, init_script: Option<String>) -> Result<(), String> {
    if let Some(webview) = app.get_webview(BROWSER_LABEL) {
        apply_bounds(&webview, bounds)?;
        return webview.show().map_err(|e| e.to_string());
    }
    let window = app.get_window("main").ok_or_else(|| "ไม่พบหน้าต่างหลัก".to_string())?;
    let dev_url = app.config().build.dev_url.clone();
    let popup_app = app.clone();
    let load_app = app.clone();
    let title_app = app.clone();
    let mut builder = tauri::webview::WebviewBuilder::new(BROWSER_LABEL, tauri::WebviewUrl::External("about:blank".parse().unwrap()))
        // ครอบทุกการนำทาง รวมถึงลิงก์และ script ในหน้า ไม่ใช่แค่ที่ agent สั่ง
        .on_navigation(move |url| browser_url_allowed(dev_url.as_ref(), url))
        // target=_blank / window.open → เปิดใน pane เดิม (หน้าต่างใหม่จะไม่มีการป้องกันแบบเดียวกัน)
        // นำทางทีหลัง ไม่ทำใน handler ที่ WebView2 กำลังรอคำตอบอยู่
        .on_new_window(move |url, _features| {
            let app = popup_app.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(webview) = app.get_webview(BROWSER_LABEL) {
                    let _ = webview.navigate(url);
                }
            });
            tauri::webview::NewWindowResponse::Deny
        })
        .on_page_load(move |_webview, payload| {
            let event = BrowserEvent {
                url: Some(payload.url().to_string()),
                title: None,
                loading: Some(matches!(payload.event(), tauri::webview::PageLoadEvent::Started)),
            };
            let _ = load_app.emit_to("main", "browser-state", event);
        })
        .on_document_title_changed(move |_webview, title| {
            let _ = title_app.emit_to("main", "browser-state", BrowserEvent { url: None, title: Some(title), loading: None });
        });
    if let Some(script) = init_script {
        builder = builder.initialization_script(script);
    }
    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(bounds.x, bounds.y),
            tauri::LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
        )
        .map_err(|e| format!("เปิด browser pane ไม่สำเร็จ: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn browser_set_bounds(app: AppHandle, bounds: PaneBounds) -> Result<(), String> {
    match app.get_webview(BROWSER_LABEL) {
        Some(webview) => apply_bounds(&webview, bounds),
        None => Ok(()),
    }
}

/// หลังคลิกใน pane keyboard จะอยู่ที่ webview นั้น — ใช้ตอนต้องให้พิมพ์ต่อในหน้าแอป
#[tauri::command]
async fn browser_focus_app(app: AppHandle) -> Result<(), String> {
    let webview = app.get_webview("main").ok_or_else(|| "ไม่พบหน้าต่างหลัก".to_string())?;
    webview.set_focus().map_err(|e| e.to_string())
}

/// ซ่อนตอนมีหน้าต่างของแอปมาทับ (webview อยู่บนสุดเสมอ จะบัง modal) หรือตอนผู้ใช้ปิด pane — หน้าเว็บยังอยู่
#[tauri::command]
async fn browser_set_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let Some(webview) = app.get_webview(BROWSER_LABEL) else { return Ok(()) };
    if visible { webview.show() } else { webview.hide() }.map_err(|e| e.to_string())
}

/// URL ปัจจุบันของ pane (None = ยังไม่ได้เปิด)
#[tauri::command]
async fn browser_url(app: AppHandle) -> Result<Option<String>, String> {
    match app.get_webview(BROWSER_LABEL) {
        Some(webview) => webview.url().map(|u| Some(u.to_string())).map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

/// นำทางด้วย Page.navigate — คืนผลของ DevTools (มี errorText เมื่อโหลดไม่ได้ เช่น dev server ไม่ได้รัน)
#[tauri::command]
async fn browser_navigate(app: AppHandle, url: String) -> Result<String, String> {
    let url = check_browser_url(&app, &url)?;
    let params = serde_json::json!({ "url": url.as_str() }).to_string();
    devtools_call(&app, "Page.navigate", params).await
}

#[tauri::command]
async fn browser_cdp(app: AppHandle, method: String, params: String) -> Result<String, String> {
    if !BROWSER_CDP_METHODS.contains(&method.as_str()) {
        return Err(format!("DevTools method {} is not allowed", method));
    }
    devtools_call(&app, &method, params).await
}

#[cfg(windows)]
async fn devtools_call(app: &AppHandle, method: &str, params: String) -> Result<String, String> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows_core::HSTRING;

    type Reply = Arc<Mutex<Option<tokio::sync::oneshot::Sender<Result<String, String>>>>>;
    fn send(reply: &Reply, result: Result<String, String>) {
        if let Some(tx) = reply.lock().unwrap().take() {
            let _ = tx.send(result);
        }
    }

    let webview = browser_webview(app)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let reply: Reply = Arc::new(Mutex::new(Some(tx)));
    let method_name = method.to_string();
    let outer = reply.clone();
    // COM ของ WebView2 ต้องเรียกบน UI thread — with_webview พาไปให้ แล้วผลกลับมาทาง callback
    webview
        .with_webview(move |platform| {
            let inner = outer.clone();
            let started = unsafe {
                platform.controller().CoreWebView2().and_then(|core| {
                    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
                        send(&inner, result.map(|_| json.clone()).map_err(|e| format!("{} {}", e.message(), json)));
                        Ok(())
                    }));
                    core.CallDevToolsProtocolMethod(&HSTRING::from(method_name.as_str()), &HSTRING::from(params.as_str()), &handler)
                })
            };
            if let Err(e) = started {
                send(&outer, Err(e.message()));
            }
        })
        .map_err(|e| e.to_string())?;
    match tokio::time::timeout(Duration::from_secs(30), rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(format!("{} ไม่ได้รับคำตอบ", method)),
        Err(_) => Err(format!("{} ใช้เวลานานเกิน 30 วินาที", method)),
    }
}

#[cfg(not(windows))]
async fn devtools_call(_app: &AppHandle, _method: &str, _params: String) -> Result<String, String> {
    Err("browser pane รองรับเฉพาะ Windows".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            check_security,
            execute_command,
            start_background_command,
            read_background_output,
            kill_command,
            read_file,
            read_file_lines,
            write_file,
            read_binary_file,
            write_binary_file,
            gdocx_url,
            design_list,
            design_create,
            design_commit,
            design_versions,
            design_restore,
            design_export,
            design_preview_url,
            list_dir,
            get_initial_env,
            load_api_keys,
            save_api_key,
            list_skills,
            read_skill_file,
            install_user_skill,
            uninstall_user_skill,
            mcp_secrets_present,
            command_available,
            mcp_start,
            mcp_send,
            mcp_stop,
            mcp_http_request,
            mcp_oauth_login,
            mcp_oauth_cancel,
            mcp_oauth_logout,
            mcp_oauth_status,
            web_fetch,
            browser_open,
            browser_set_bounds,
            browser_set_visible,
            browser_focus_app,
            browser_url,
            browser_navigate,
            browser_cdp,
            save_session_history,
            load_session_history,
            delete_session_history,
            save_chat_session,
            load_chat_sessions,
            delete_chat_session,
            save_checkpoint,
            load_checkpoints,
            delete_checkpoint,
            delete_checkpoints,
            select_folder,
            edit_file,
            snapshot_file,
            restore_file,
            git_snapshot,
            git_restore_snapshot,
            grep_search,
            find_files,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        // ปิดแอปแล้วต้องไม่ทิ้ง dev server หรือคำสั่งที่ค้างไว้ (taskkill /T ฆ่าทั้งทรีของ process)
        if let tauri::RunEvent::Exit = event {
            let state = handle.state::<AppState>();
            let mut pids: Vec<u32> = state.running_processes.lock().unwrap().drain().map(|(_, pid)| pid).collect();
            pids.extend(state.mcp.lock().unwrap().drain().map(|(_, p)| p.pid));
            for pid in pids {
                kill_process_tree(pid);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gdocx_serves_only_its_own_files() {
        let req = |target: &str| format!("GET {} HTTP/1.1\r\nHost: 127.0.0.1:17420\r\n\r\n", target);
        let status = |target: &str| gdocx_response(&req(target), 17420).0;
        assert!(status("/index.html?embedded").starts_with("200"));
        assert!(status("/js/api.js").starts_with("200"));
        assert_eq!(gdocx_response(&req("/js/api.js"), 17420).1, "text/javascript; charset=utf-8");
        assert!(status("/README.md").starts_with("404"));
        assert!(status("/../src/lib.rs").starts_with("404"));
        assert!(status("/js/../../secret").starts_with("404"));
    }

    #[test]
    fn gdocx_rejects_other_hosts_and_methods() {
        let other = "GET /index.html HTTP/1.1\r\nHost: evil.example:17420\r\n\r\n";
        assert!(gdocx_response(other, 17420).0.starts_with("403"));
        let post = "POST /index.html HTTP/1.1\r\nHost: 127.0.0.1:17420\r\n\r\n";
        assert!(gdocx_response(post, 17420).0.starts_with("405"));
    }

    fn design_temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dex-design-test-{}-{}", name, uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(dir).unwrap()
    }

    const SAMPLE_SKILL: &str = "---\nname: sample\ndescription: A sample skill\n---\n\nDo the thing.\n";

    #[test]
    fn marketplace_skill_installs_and_uninstalls() {
        let root = design_temp_dir("skill-install");
        let dir = install_skill_in(&root, "sample", SAMPLE_SKILL).unwrap();
        assert_eq!(fs::read_to_string(dir.join("SKILL.md")).unwrap(), SAMPLE_SKILL);

        let found = scan_skills(&[(root.clone(), "user")]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "sample");
        assert!(found[0].managed);

        // ติดตั้งซ้ำ = อัปเดตของเดิมได้
        install_skill_in(&root, "sample", "---\nname: sample\ndescription: New\n---\n").unwrap();
        assert_eq!(scan_skills(&[(root.clone(), "user")])[0].description, "New");

        uninstall_skill_in(&root, "sample").unwrap();
        assert!(!dir.exists());
        // ไม่มีอยู่แล้วก็ไม่ error (เช่น ผู้ใช้ลบโฟลเดอร์เองไปก่อน)
        uninstall_skill_in(&root, "sample").unwrap();
    }

    #[test]
    fn marketplace_never_touches_a_skill_the_user_wrote() {
        let root = design_temp_dir("skill-own");
        let dir = root.join("mine");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), SAMPLE_SKILL).unwrap();

        assert!(install_skill_in(&root, "mine", "overwrite").is_err());
        assert!(uninstall_skill_in(&root, "mine").is_err());
        assert_eq!(fs::read_to_string(dir.join("SKILL.md")).unwrap(), SAMPLE_SKILL);
        assert!(!scan_skills(&[(root.clone(), "user")])[0].managed);
    }

    #[test]
    fn workspace_skill_with_a_marker_is_not_managed() {
        // repo ที่ไม่รู้จักใส่ marker มาเอง ก็ต้องไม่ถูกนับว่าเป็นของ Marketplace
        let root = design_temp_dir("skill-workspace");
        install_skill_in(&root, "sample", SAMPLE_SKILL).unwrap();
        assert!(!scan_skills(&[(root.clone(), "workspace")])[0].managed);
    }

    #[test]
    fn skill_names_cannot_escape_the_skill_root() {
        let root = design_temp_dir("skill-traversal");
        let victim = root.join("victim");
        fs::create_dir_all(&victim).unwrap();
        fs::write(victim.join(MANAGED_SKILL_MARKER), "").unwrap();
        let skills = root.join("skills");
        fs::create_dir_all(&skills).unwrap();

        for name in ["../victim", "..\\victim", "a/b", "", ".."] {
            assert!(install_skill_in(&skills, name, SAMPLE_SKILL).is_err(), "install {:?}", name);
            assert!(uninstall_skill_in(&skills, name).is_err(), "uninstall {:?}", name);
        }
        assert!(victim.exists());
    }

    #[test]
    fn find_on_path_uses_the_extensions_spawn_mcp_tries() {
        let dir = design_temp_dir("find-on-path");
        let tool = if cfg!(windows) { "tool.cmd" } else { "tool" };
        fs::write(dir.join(tool), "").unwrap();
        let other = design_temp_dir("find-on-path-other");
        let path = std::env::join_paths([other, dir.clone()]).unwrap();

        assert!(find_on_path("tool", &path));
        assert!(!find_on_path("missing", &path));
        // โฟลเดอร์ชื่อเดียวกันไม่ใช่โปรแกรม
        fs::create_dir(dir.join(if cfg!(windows) { "folder.exe" } else { "folder" })).unwrap();
        assert!(!find_on_path("folder", &path));
    }

    #[test]
    fn command_available_only_accepts_plain_names() {
        for name in ["../evil", "..\\evil", "C:\\Windows\\notepad", "", "a b"] {
            assert!(!command_available(name.to_string()), "{:?}", name);
        }
    }

    #[test]
    fn expand_env_reads_environment_variables() {
        std::env::set_var("DEX_TEST_EXPAND_ENV", "value");
        assert_eq!(expand_env("Bearer ${DEX_TEST_EXPAND_ENV}"), "Bearer value");
        assert_eq!(expand_env("a${DEX_TEST_MISSING_VAR}b"), "ab");
        assert_eq!(expand_env("no vars"), "no vars");
        let present = mcp_secrets_present(vec!["DEX_TEST_EXPAND_ENV".into(), "DEX_TEST_MISSING_VAR".into()]);
        assert_eq!(present["DEX_TEST_EXPAND_ENV"], true);
        assert_eq!(present["DEX_TEST_MISSING_VAR"], false);
    }

    #[test]
    fn design_server_serves_only_project_files_to_the_right_token() {
        let root = design_temp_dir("serve");
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::create_dir_all(root.join(".versions/2")).unwrap();
        fs::write(root.join("index.html"), "<h1>now</h1>").unwrap();
        fs::write(root.join("assets/app.css"), "a{}").unwrap();
        fs::write(root.join("design.json"), "{}").unwrap();
        fs::write(root.join(".gitignore"), ".versions/").unwrap();
        fs::write(root.join("server.key"), "secret").unwrap();
        fs::write(root.join("data.bin"), "x").unwrap();
        fs::write(root.join(".versions/2/index.html"), "<h1>old</h1>").unwrap();
        fs::write(root.join(".versions/index.json"), "[]").unwrap();
        let outside = root.parent().unwrap().join(format!("{}-outside.html", root.file_name().unwrap().to_string_lossy()));
        fs::write(&outside, "secret").unwrap();

        let get = |target: &str| {
            let req = format!("GET {} HTTP/1.1\r\nHost: 127.0.0.1:9000\r\n\r\n", target);
            design_response(&req, 9000, |token| (token == "tok").then(|| root.clone()))
        };
        assert_eq!(get("/tok/").2, b"<h1>now</h1>");
        assert_eq!(get("/tok").2, b"<h1>now</h1>");
        assert_eq!(get("/tok/index.html?x=1").1, "text/html; charset=utf-8");
        assert_eq!(get("/tok/assets/app.css").1, "text/css; charset=utf-8");
        assert_eq!(get("/tok/.versions/2/index.html").2, b"<h1>old</h1>");
        for blocked in [
            "/wrong/index.html",
            "/index.html",
            "/tok/design.json",
            "/tok/.gitignore",
            "/tok/server.key",
            "/tok/data.bin",
            "/tok/.versions/index.json",
            "/tok/.versions/x/index.html",
            "/tok/../outside.html",
            "/tok/%2e%2e/outside.html",
            "/tok/assets/../../outside.html",
            "/tok/..\\outside.html",
        ] {
            assert!(get(blocked).0.starts_with("404"), "{} should be blocked", blocked);
        }
        let _ = fs::remove_file(outside);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn design_comments_stay_out_of_versions_exports_and_the_server() {
        let root = design_temp_dir("comments");
        fs::write(root.join("index.html"), "one").unwrap();
        fs::write(root.join("comments.json"), "[]").unwrap();
        assert_eq!(design_commit_files(&root, "first").unwrap().version, 1);
        assert!(!root.join(".versions/1/comments.json").exists());
        // แก้แค่คอมเมนต์ไม่ใช่เวอร์ชันใหม่ และ restore ไม่ลบคอมเมนต์
        fs::write(root.join("comments.json"), "[{}]").unwrap();
        assert_eq!(design_commit_files(&root, "again").unwrap().version, 1);
        design_restore_files(&root, 1).unwrap();
        assert_eq!(fs::read_to_string(root.join("comments.json")).unwrap(), "[{}]");
        let req = "GET /t/comments.json HTTP/1.1\r\nHost: 127.0.0.1:9000\r\n\r\n";
        assert!(design_response(req, 9000, |_| Some(root.clone())).0.starts_with("404"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn design_compare_page_lists_only_root_html_files() {
        let root = design_temp_dir("compare");
        fs::create_dir_all(root.join("sub")).unwrap();
        for name in ["index.html", "variant-a.html", "site.css", "sub/deep.html", "a b.html"] {
            fs::write(root.join(name), "x").unwrap();
        }
        let get = |target: &str| {
            let req = format!("GET {} HTTP/1.1\r\nHost: 127.0.0.1:9000\r\n\r\n", target);
            let (status, _, body) = design_response(&req, 9000, |_| Some(root.clone()));
            (status, String::from_utf8(body).unwrap())
        };
        let (status, page) = get("/t/__compare?width=390");
        assert!(status.starts_with("200"));
        assert!(page.contains(r#"src="index.html""#) && page.contains(r#"src="variant-a.html""#));
        assert!(!page.contains("site.css") && !page.contains("deep.html") && !page.contains("a b.html"));
        assert!(page.contains("WIDTH=390"));
        assert!(get("/t/__compare?width=<script>").1.contains("WIDTH=1440"));
        assert!(get("/t/__compare?width=999999").1.contains("WIDTH=3000"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn design_server_rejects_other_hosts_and_methods() {
        let root = |_: &str| Some(PathBuf::from("."));
        assert!(design_response("GET /t/ HTTP/1.1\r\nHost: evil.example:9000\r\n\r\n", 9000, root).0.starts_with("403"));
        assert!(design_response("POST /t/ HTTP/1.1\r\nHost: 127.0.0.1:9000\r\n\r\n", 9000, root).0.starts_with("405"));
    }

    #[test]
    fn design_versions_round_trip_and_keep_the_state_before_restore() {
        let root = design_temp_dir("versions");
        fs::write(root.join("design.json"), "{}").unwrap();
        fs::write(root.join("index.html"), "one").unwrap();
        assert_eq!(design_commit_files(&root, "first").unwrap().version, 1);
        // ไฟล์ไม่เปลี่ยน = ไม่สร้างเวอร์ชันใหม่
        assert_eq!(design_commit_files(&root, "again").unwrap().version, 1);
        fs::write(root.join("index.html"), "two").unwrap();
        fs::write(root.join("extra.css"), "b{}").unwrap();
        assert_eq!(design_commit_files(&root, "second").unwrap().version, 2);
        // แก้ค้างไว้โดยยังไม่ commit — ต้องไม่หายตอน restore
        fs::write(root.join("index.html"), "unsaved").unwrap();

        let restored = design_restore_files(&root, 1).unwrap();
        assert_eq!(restored.version, 4);
        assert_eq!(fs::read_to_string(root.join("index.html")).unwrap(), "one");
        assert!(!root.join("extra.css").exists(), "files added after v1 are gone");
        assert_eq!(fs::read_to_string(root.join(".versions/3/index.html")).unwrap(), "unsaved");
        assert!(design_restore_files(&root, 99).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn design_versions_are_capped() {
        let root = design_temp_dir("cap");
        for n in 0..DESIGN_MAX_VERSIONS + 2 {
            fs::write(root.join("index.html"), n.to_string()).unwrap();
            design_commit_files(&root, "edit").unwrap();
        }
        let versions = design_read_versions(&root);
        assert_eq!(versions.len(), DESIGN_MAX_VERSIONS);
        assert_eq!(versions[0].version, 3);
        assert!(!root.join(".versions/2").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn design_names_cannot_escape_the_project() {
        assert_eq!(design_slug("Landing Page: V2!"), "landing-page-v2");
        assert_eq!(design_slug("หน้าแรก"), "design");
        assert!(is_design_id("landing-page-2"));
        for id in ["", "..", "../x", "a/b", "a\\b", "A", ".hidden"] {
            assert!(!is_design_id(id), "{:?}", id);
        }
        assert!(is_design_segment("index.html"));
        for segment in ["", ".", "..", ".env", "a b", "a%2fb", "a\\b", "หน้า.html"] {
            assert!(!is_design_segment(segment), "{:?}", segment);
        }
    }

    #[test]
    fn backup_keeps_the_extension_so_word_can_open_it() {
        assert_eq!(backup_path(Path::new(r"D:\w\report.docx")), PathBuf::from(r"D:\w\report.dex-backup.docx"));
    }

    #[test]
    fn workspace_prefix_is_component_based() {
        let ws = Path::new(r"D:\Pokemon_cli");
        assert!(is_within(Path::new(r"D:\Pokemon_cli"), ws));
        assert!(is_within(Path::new(r"d:\pokemon_cli\src\App.tsx"), ws));
        assert!(is_within(Path::new(r"\\?\D:\Pokemon_cli\src"), ws));
        assert!(!is_within(Path::new(r"D:\Pokemon_cli_evil\x.txt"), ws));
        assert!(!is_within(Path::new(r"D:\Pokemon_cli2"), ws));
    }

    // workspace ปลอมที่ไม่มีอยู่จริง — เช็คแบบ lexical ล้วน ไม่ขึ้นกับเครื่องที่รันเทสต์
    const TEST_WS: &str = r"C:\dex_test_ws";

    fn sec(cmd: &str) -> SecurityCheckResult {
        check_security(cmd.to_string(), Some(TEST_WS.to_string()))
    }

    fn ro(cmd: &str) -> bool {
        sec(cmd).is_read_only
    }

    #[test]
    fn read_only_paths_must_stay_in_workspace() {
        assert!(ro("cat src/App.tsx"));
        assert!(ro(r"get-content -Path src\main.rs -Tail 20"));
        assert!(ro("dir src"));
        assert!(ro(r"cat C:\dex_test_ws\src\a.ts"));
        assert!(ro("select-string useState *.tsx"));
        assert!(!ro(r"cat C:\Users\me\.ssh\id_rsa"));
        assert!(!ro(r"type ..\..\secret.txt"));
        assert!(!ro(r"gc -Path:D:\other\x.txt"));
        assert!(!ro(r"dir \\server\share"));
        assert!(!ro("gci env:"));
        assert!(!ro("cat env:OPENAI_API_KEY"));
        assert!(!ro("echo $env:OPENAI_API_KEY"));
        assert!(!ro("ls ~"));
    }

    #[test]
    fn read_only_never_reads_secrets() {
        assert!(!ro("cat .env"));
        assert!(!ro("get-content src/../.env.local"));
        assert!(!ro("type server.pem"));
        assert!(!ro("cat *"));
        assert!(!ro("select-string KEY .e*"));
        assert!(ro("cat .env.example"));
        // แค่ดูว่ามีไฟล์อยู่ ไม่ได้อ่านเนื้อหา
        assert!(ro("test-path .env"));
    }

    #[test]
    fn sensitive_names() {
        for n in [".env", ".env.local", ".ENV.production", "prod.env", "id_rsa", "cert.pem", "app.key", ".npmrc"] {
            assert!(is_sensitive_name(n), "{n}");
        }
        for n in [".env.example", ".env.local.sample", "id_rsa.pub", "App.tsx", "keys.ts", "environment.ts"] {
            assert!(!is_sensitive_name(n), "{n}");
        }
        assert!(is_sensitive_path(Path::new(r"C:\Users\me\.ssh\config")));
        assert!(!is_sensitive_path(Path::new(r"D:\ws\src\env.ts")));
    }

    #[test]
    fn chaining_is_reported() {
        assert!(sec("npm test; rm -rf x").has_chaining);
        assert!(!sec("npm test").has_chaining);
    }

    #[test]
    fn read_only_allowlist_is_strict() {
        assert!(ro("dir"));
        assert!(ro("git status"));
        assert!(ro("git branch -a"));
        assert!(ro("node -v"));
        assert!(!ro("dir\nRemove-Item -Recurse foo"));
        assert!(!ro("dir; Remove-Item foo"));
        assert!(!ro("git branch -D main"));
        assert!(!ro("git diff --output=out.patch"));
        assert!(!ro("cargo check"));
        assert!(!ro("lsass.exe"));
        assert!(!ro("echo hi > out.txt"));
    }

    #[test]
    fn hard_block_uses_tokens() {
        assert!(!sec("Stop-Computer -Force").safe);
        assert!(!sec("shutdown /s /t 0").safe);
        assert!(sec("git log --grep=shutdown-handler").safe);
        assert!(sec("npm run format").safe);
    }

    fn op(target: &str, replacement: &str, replace_all: bool) -> EditOp {
        EditOp { target_content: target.into(), replacement_content: replacement.into(), replace_all }
    }

    #[test]
    fn edits_apply_in_order_and_keep_crlf() {
        let (out, n) = apply_edits("a\r\nb\r\na\r\n", &[op("b\n", "B\n", false), op("a", "x", true)]).unwrap();
        assert_eq!(out, "x\r\nB\r\nx\r\n");
        assert_eq!(n, 3);
        // ซ้ำโดยไม่มี replace_all → error และไม่มีอะไรถูกแก้
        assert!(apply_edits("a a", &[op("a", "b", false)]).unwrap_err().contains("ซ้ำกัน 2"));
        assert!(apply_edits("abc", &[op("b", "B", false), op("zzz", "", false)]).unwrap_err().contains("edit #2"));
        assert!(apply_edits("abc", &[]).is_err());
        assert!(apply_edits("abc", &[op("", "x", false)]).is_err());
    }

    #[test]
    fn read_lines_pages_through_a_file() {
        let dir = std::env::temp_dir().join(format!("dex_read_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("big.txt");
        let body: String = (1..=10).map(|i| format!("line {}\r\n", i)).collect();
        fs::write(&file, body).unwrap();

        let all = read_lines_from(&file, 1, 2000, 40_000).unwrap();
        assert_eq!((all.start_line, all.end_line, all.total_lines), (1, 10, 10));
        assert!(all.content.starts_with("     1\tline 1\n"));

        let page = read_lines_from(&file, 4, 3, 40_000).unwrap();
        assert_eq!((page.start_line, page.end_line, page.total_lines), (4, 6, 10));
        assert_eq!(page.content.lines().count(), 3);

        // งบตัวอักษรหมดก่อน limit — ได้อย่างน้อยหนึ่งบรรทัดเสมอ
        let tight = read_lines_from(&file, 1, 2000, 10).unwrap();
        assert_eq!(tight.end_line, 1);

        let long = dir.join("long.txt");
        fs::write(&long, "x".repeat(MAX_LINE_CHARS + 50)).unwrap();
        assert_eq!(read_lines_from(&long, 1, 10, 40_000).unwrap().truncated_lines, 1);

        let bin = dir.join("bin.dat");
        fs::write(&bin, [0u8, 1, 2, 3]).unwrap();
        assert!(read_lines_from(&bin, 1, 10, 40_000).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn globs_match_names_or_paths() {
        let ts = build_glob("*.ts").unwrap();
        assert!(ts.is_match("src/a.ts") && ts.is_match("a.ts") && !ts.is_match("a.tsx"));
        let tests = build_glob("src/**/*.test.ts").unwrap();
        assert!(tests.is_match("src/x/y.test.ts") && !tests.is_match("lib/y.test.ts"));
        assert!(build_glob("src/[").is_err());
        let m = build_line_matcher("a.b", false, true).unwrap();
        assert!(m.is_match("A.B") && !m.is_match("axb"));
        assert!(build_line_matcher(r"fn \w+\(", true, false).unwrap().is_match("fn main("));
    }

    #[test]
    fn background_buffer_keeps_the_newest_output() {
        let mut out = BackgroundOutput::default();
        out.push_line("first");
        let big = "ก".repeat(MAX_BACKGROUND_BUFFER); // อักษรไทย 3 ไบต์ — ตัดต้องไม่กลางตัวอักษร
        out.push_line(&big);
        assert!(out.pending.len() <= MAX_BACKGROUND_BUFFER + 3);
        assert!(!out.pending.contains("first"));
        assert!(out.dropped_bytes > 0);
        assert!(out.pending.ends_with("ก\n"));
    }

    #[test]
    fn frontmatter_handles_simple_and_folded_values() {
        let meta = parse_frontmatter(
            "---\nname: pdf-tools\ndescription: >\n  Fill and merge PDFs.\n  Use for any .pdf task.\nlicense: \"MIT\"\n---\n# Body\n",
        );
        assert_eq!(meta.get("name").map(String::as_str), Some("pdf-tools"));
        assert_eq!(meta.get("description").map(String::as_str), Some("Fill and merge PDFs. Use for any .pdf task."));
        assert_eq!(meta.get("license").map(String::as_str), Some("MIT"));
        assert!(parse_frontmatter("# no frontmatter").is_empty());
    }

    #[test]
    fn skills_are_discovered_and_sandboxed() {
        let ws = std::env::temp_dir().join(format!("dex_skills_{}", std::process::id()));
        let skill = ws.join(".dex").join("skills").join("release");
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), "---\nname: release\ndescription: Cut a release\n---\nSteps").unwrap();
        fs::write(skill.join("checklist.md"), "1. tag").unwrap();
        // ไม่มี description → ไม่นับเป็น skill
        let broken = ws.join(".claude").join("skills").join("broken");
        fs::create_dir_all(&broken).unwrap();
        fs::write(broken.join("skill.md"), "---\nname: broken\n---\n").unwrap();

        let roots = vec![(ws.join(".dex").join("skills"), "workspace"), (ws.join(".claude").join("skills"), "workspace")];
        let found = scan_skills(&roots);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "release");

        let ws_str = Some(ws.to_string_lossy().to_string());
        let dir = found[0].dir.clone();
        assert!(read_skill_file(dir.clone(), None, ws_str.clone()).unwrap().contains("Steps"));
        assert_eq!(read_skill_file(dir.clone(), Some("checklist.md".into()), ws_str.clone()).unwrap(), "1. tag");
        assert!(read_skill_file(dir.clone(), Some(r"..\..\..\x.txt".into()), ws_str.clone()).is_err());
        assert!(read_skill_file(ws.to_string_lossy().to_string(), None, ws_str).is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn mcp_stdio_pipe_round_trips_a_line() {
        use tokio::io::AsyncWriteExt;
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            // echo server: อ่านทีละบรรทัดจาก stdin แล้วตอบกลับพร้อมค่าจาก env
            let script = "require('readline').createInterface({input:process.stdin}).on('line',l=>console.log(l+' '+process.env.DEX_MCP_TEST))";
            let env = HashMap::from([("DEX_MCP_TEST".to_string(), "ok".to_string())]);
            let Ok(mut child) = spawn_mcp("node", &["-e".to_string(), script.to_string()], &env, None) else {
                eprintln!("node not found — skipping");
                return;
            };
            let mut stdin = child.stdin.take().unwrap();
            let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
            stdin.write_all(b"{\"jsonrpc\":\"2.0\"}\n").await.unwrap();
            stdin.flush().await.unwrap();
            let line = tokio::time::timeout(Duration::from_secs(20), lines.next_line()).await.unwrap().unwrap();
            assert_eq!(line.as_deref(), Some("{\"jsonrpc\":\"2.0\"} ok"));
            let _ = child.kill().await;
        });
    }

    #[test]
    fn git_snapshot_restores_shell_changes() {
        let repo = std::env::temp_dir().join(format!("dex_git_{}", std::process::id()));
        let _ = fs::remove_dir_all(&repo);
        let ws = repo.join("app");
        fs::create_dir_all(&ws).unwrap();
        let git = |args: &[&str]| git_command(&repo, args, None).unwrap();
        if git_command(&repo, &["init", "-q"], None).is_err() {
            eprintln!("git not found — skipping");
            return;
        }
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "t"]);
        git(&["config", "core.autocrlf", "false"]);
        fs::write(ws.join("keep.txt"), "v1").unwrap();
        fs::write(ws.join("gone.txt"), "will be deleted").unwrap();
        fs::write(repo.join("outside.txt"), "outside").unwrap();
        fs::write(repo.join(".gitignore"), "*.log\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-qm", "init"]);
        // งานค้างของผู้ใช้ก่อน snapshot: แก้ไฟล์ + ไฟล์ untracked
        fs::write(ws.join("keep.txt"), "v2 uncommitted").unwrap();
        fs::write(ws.join("draft.txt"), "untracked draft").unwrap();

        let tree = workspace_tree(&ws).unwrap();
        let status_before = git_text(&repo, &["status", "--porcelain"], None).unwrap();

        // "คำสั่ง shell" แก้ เพิ่ม ลบ — ทั้งใน workspace, นอก workspace และไฟล์ ignored
        fs::write(ws.join("keep.txt"), "v3 by shell").unwrap();
        fs::remove_file(ws.join("gone.txt")).unwrap();
        fs::create_dir_all(ws.join("new")).unwrap();
        fs::write(ws.join("new").join("made.txt"), "x").unwrap();
        fs::write(ws.join("build.log"), "ignored").unwrap();
        fs::write(repo.join("outside.txt"), "changed outside").unwrap();

        let mut changed = restore_snapshot(&ws, &tree).unwrap();
        changed.sort();
        assert_eq!(changed, vec!["gone.txt", "keep.txt", "new/made.txt"]);
        assert_eq!(fs::read_to_string(ws.join("keep.txt")).unwrap(), "v2 uncommitted");
        assert_eq!(fs::read_to_string(ws.join("gone.txt")).unwrap(), "will be deleted");
        assert_eq!(fs::read_to_string(ws.join("draft.txt")).unwrap(), "untracked draft");
        assert!(!ws.join("new").exists());
        // ไฟล์ ignored และไฟล์นอก workspace ไม่ถูกแตะ
        assert!(ws.join("build.log").exists());
        assert_eq!(fs::read_to_string(repo.join("outside.txt")).unwrap(), "changed outside");
        // index จริงของผู้ใช้ไม่เปลี่ยน (draft.txt ยังเป็น untracked ไม่ถูก stage)
        let status_after = git_text(&repo, &["status", "--porcelain"], None).unwrap();
        assert!(status_after.contains("?? app/draft.txt"));
        assert!(status_before.contains("?? app/draft.txt"));
        assert!(restore_snapshot(&ws, &tree).unwrap().is_empty());
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn env_placeholders_expand() {
        std::env::set_var("DEX_TEST_TOKEN", "s3cret");
        assert_eq!(expand_env("Bearer ${DEX_TEST_TOKEN}"), "Bearer s3cret");
        assert_eq!(expand_env("${DEX_TEST_MISSING_VAR}x"), "x");
        assert_eq!(expand_env("no vars"), "no vars");
        assert_eq!(expand_env("broken ${OPEN"), "broken ${OPEN");
    }

    #[test]
    fn snapshot_and_restore_round_trip() {
        let ws = std::env::temp_dir().join(format!("dex_ckpt_{}", std::process::id()));
        fs::create_dir_all(&ws).unwrap();
        let ws_str = Some(ws.to_string_lossy().to_string());
        let existing = ws.join("a.txt");
        fs::write(&existing, "original").unwrap();
        let path = existing.to_string_lossy().to_string();
        let created = ws.join("sub").join("new.txt").to_string_lossy().to_string();

        // ไฟล์ที่มีอยู่ → ได้เนื้อหาเดิม, ไฟล์ที่ยังไม่มี → None
        assert_eq!(snapshot_file(path.clone(), ws_str.clone(), None).unwrap().as_deref(), Some("original"));
        assert_eq!(snapshot_file(created.clone(), ws_str.clone(), None).unwrap(), None);

        fs::write(&existing, "changed by agent").unwrap();
        write_file(created.clone(), "brand new".into(), ws_str.clone(), None).unwrap();

        restore_file(path.clone(), Some("original".into()), ws_str.clone()).unwrap();
        restore_file(created.clone(), None, ws_str.clone()).unwrap();
        assert_eq!(fs::read_to_string(&existing).unwrap(), "original");
        assert!(!Path::new(&created).exists());

        // นอก workspace ห้าม restore
        let outside = std::env::temp_dir().join("dex_outside.txt").to_string_lossy().to_string();
        assert!(restore_file(outside, None, ws_str.clone()).is_err());
        // ไฟล์ลับต้องขอสิทธิ์ก่อน snapshot
        assert!(snapshot_file(ws.join(".env").to_string_lossy().to_string(), ws_str, None).is_err());

        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn checkpoints_are_stored_per_turn_and_removed_per_chat() {
        let root = std::env::temp_dir().join(format!("dex_ckpt_store_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);

        write_checkpoint(&root, "session-1", "asst-1", "{\"a\":1}").unwrap();
        write_checkpoint(&root, "session-1", "asst-2", "{\"a\":2}").unwrap();
        write_checkpoint(&root, "session-1", "asst-2", "{\"a\":3}").unwrap();
        write_checkpoint(&root, "session-2", "asst-9", "{\"a\":9}").unwrap();

        let mut loaded = read_json_files(&checkpoint_dir(&root, "session-1").unwrap());
        loaded.sort();
        assert_eq!(loaded, vec!["{\"a\":1}", "{\"a\":3}"]);

        remove_checkpoint(&root, "session-1", "asst-1").unwrap();
        remove_checkpoint(&root, "session-1", "asst-1").unwrap();
        assert_eq!(read_json_files(&checkpoint_dir(&root, "session-1").unwrap()), vec!["{\"a\":3}"]);

        remove_checkpoints(&root, "session-1").unwrap();
        remove_checkpoints(&root, "session-1").unwrap();
        assert!(read_json_files(&checkpoint_dir(&root, "session-1").unwrap()).is_empty());
        assert_eq!(read_json_files(&checkpoint_dir(&root, "session-2").unwrap()).len(), 1);

        // id ที่พาออกนอกโฟลเดอร์ต้องถูกปฏิเสธ
        assert!(write_checkpoint(&root, "..", "asst-1", "x").is_err());
        assert!(write_checkpoint(&root, "session-1", "../../evil", "x").is_err());
        assert!(remove_checkpoints(&root, "..").is_err());
        assert!(remove_checkpoints(&root, "").is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn browser_pane_never_opens_the_app_itself() {
        let dev = url::Url::parse("http://localhost:1420").unwrap();
        let ok = |u: &str| browser_url_allowed(Some(&dev), &url::Url::parse(u).unwrap());
        assert!(ok("http://localhost:5173/"));
        assert!(ok("http://127.0.0.1:1420/"), "ต่าง host จาก devUrl = Tauri ไม่ถือเป็นหน้าของแอป");
        assert!(ok("https://example.com/a?b=1"));
        assert!(ok("about:blank"));
        assert!(!ok("http://localhost:1420/"));
        assert!(!ok("http://localhost:1420/settings"));
        assert!(!ok("http://tauri.localhost/"));
        assert!(!ok("http://ipc.localhost/cmd"));
        assert!(!ok("tauri://localhost/"));
        assert!(!ok("file:///C:/Users/me/.ssh/id_rsa"));
        assert!(!ok("javascript:alert(1)"));
        assert!(!ok("https://user:pw@example.com/"));
        assert!(BROWSER_CDP_METHODS.contains(&"Runtime.evaluate"));
        assert!(!BROWSER_CDP_METHODS.contains(&"Network.getCookies"));
    }

    #[test]
    fn web_urls_are_validated() {
        assert!(parse_web_url("https://docs.rs/regex").is_ok());
        assert!(parse_web_url("  http://localhost:1420/  ").is_ok());
        assert!(parse_web_url("file:///C:/Windows/win.ini").is_err());
        assert!(parse_web_url("ftp://example.com").is_err());
        assert!(parse_web_url("https://user:pass@example.com").is_err());
        assert!(parse_web_url("not a url").is_err());
    }

    #[test]
    fn web_pages_become_readable_text() {
        let html = br#"<!doctype html><html><head><title> Regex &amp; You </title>
            <style>body { color: red }</style><script>alert("x")</script></head>
            <body><h1>Install</h1><p>Run <code>cargo add regex</code>.</p>


            <p>See <a href="https://docs.rs/regex">the docs</a>.</p></body></html>"#;
        let page = page_from_body("https://x.dev/".into(), 200, "text/html", html, false).unwrap();
        assert_eq!(page.title.as_deref(), Some("Regex & You"));
        assert!(page.content.contains("Install"));
        assert!(page.content.contains("`cargo add regex`"));
        assert!(page.content.contains("https://docs.rs/regex"));
        assert!(!page.content.contains("alert"), "scripts are dropped: {}", page.content);
        assert!(!page.content.contains("color: red"), "styles are dropped: {}", page.content);
        assert!(!page.content.contains("\n\n\n"));

        // ไม่มี content-type: เดาว่าเป็น HTML จากเนื้อหา
        let sniffed = page_from_body("u".into(), 200, "", b"<html><body>hi</body></html>", false).unwrap();
        assert_eq!(sniffed.content_type, "text/html");
        let json = page_from_body("u".into(), 200, "application/json", br#"{"a":1}"#, false).unwrap();
        assert_eq!(json.content, r#"{"a":1}"#);
        assert!(page_from_body("u".into(), 200, "image/png", b"\x89PNG", false).is_err());
        assert!(page_from_body("u".into(), 200, "", b"\x00\x01binary", false).is_err());
    }

    #[test]
    fn json_files_are_read_and_temp_files_skipped() {
        let dir = std::env::temp_dir().join(format!("dex_chats_{}", std::process::id()));
        assert!(read_json_files(&dir).is_empty(), "missing folder = no chats");
        fs::create_dir_all(&dir).unwrap();
        write_atomic(&dir.join("session-1.json"), b"{\"id\":\"session-1\"}").unwrap();
        fs::write(dir.join(".session-2.json.dex-tmp"), "half written").unwrap();
        fs::write(dir.join("notes.txt"), "not a chat").unwrap();

        assert_eq!(read_json_files(&dir), vec!["{\"id\":\"session-1\"}".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }
}

/// flow ของ OAuth กับ mock server ที่รันบน 127.0.0.1 จริง และ MemoryStore แทน Credential Manager
#[cfg(test)]
mod oauth_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::AtomicBool;

    #[derive(Default)]
    struct MemoryStore {
        items: Mutex<HashMap<String, Vec<u8>>>,
    }

    impl OauthStore for MemoryStore {
        fn get(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
            Ok(self.items.lock().unwrap().get(name).cloned())
        }
        fn set(&self, name: &str, value: &[u8]) -> Result<(), String> {
            // ขีดจำกัดเดียวกับ Credential Manager
            assert!(value.len() <= 2560, "{} is {} bytes", name, value.len());
            self.items.lock().unwrap().insert(name.to_string(), value.to_vec());
            Ok(())
        }
        fn delete(&self, name: &str) -> Result<(), String> {
            self.items.lock().unwrap().remove(name);
            Ok(())
        }
    }

    #[derive(Clone, Copy, PartialEq)]
    enum IssMode {
        Correct,
        Wrong,
        Absent,
    }

    struct MockState {
        port: u16,
        advertise_iss: bool,
        iss_mode: IssMode,
        pkce_methods: Option<Vec<&'static str>>,
        metadata_issuer: Option<String>,
        authorization_endpoint: Option<String>,
        registration_enabled: bool,
        auth_methods: Option<Vec<&'static str>>,
        resource: Option<String>,
        as_scopes: Option<Vec<&'static str>>,
        resource_scopes: Option<Vec<&'static str>>,
        challenge_scope: Option<&'static str>,
        expires_in: Option<u64>,
        issue_refresh: bool,
        refresh_failure: Option<(u16, &'static str)>,
        token_failure: Option<(u16, &'static str)>,
        authorize_error: Option<&'static str>,
        rejects_all_access: bool,
        registrations: Vec<serde_json::Value>,
        authorize_requests: Vec<HashMap<String, String>>,
        token_requests: Vec<HashMap<String, String>>,
        token_auth_headers: Vec<Option<String>>,
        mcp_auth_headers: Vec<Option<String>>,
        leaked_requests: usize,
        next_id: usize,
        clients: HashMap<String, (Vec<String>, Option<String>)>,
        codes: HashMap<String, (String, String, String)>,
        valid_access: HashSet<String>,
        valid_refresh: HashSet<String>,
    }

    struct MockServer {
        port: u16,
        state: Arc<Mutex<MockState>>,
    }

    fn read_request(stream: &mut TcpStream) -> Option<(String, String, HashMap<String, String>, String)> {
        stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
        let mut data = Vec::new();
        let mut buf = [0u8; 4096];
        let head_end = loop {
            if let Some(pos) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                break pos + 4;
            }
            let n = stream.read(&mut buf).ok()?;
            if n == 0 {
                return None;
            }
            data.extend_from_slice(&buf[..n]);
        };
        let head = String::from_utf8_lossy(&data[..head_end]).into_owned();
        let mut lines = head.lines();
        let mut first = lines.next()?.split_whitespace();
        let method = first.next()?.to_string();
        let target = first.next()?.to_string();
        let headers: HashMap<String, String> = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
            .collect();
        let length: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
        while data.len() < head_end + length {
            let n = stream.read(&mut buf).ok()?;
            if n == 0 {
                break;
            }
            data.extend_from_slice(&buf[..n]);
        }
        let body = String::from_utf8_lossy(&data[head_end..]).into_owned();
        Some((method, target, headers, body))
    }

    fn respond(stream: &mut TcpStream, status: &str, extra: &[(&str, String)], body: &str) {
        let mut head = format!("HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n", status, body.len());
        for (name, value) in extra {
            head.push_str(&format!("{}: {}\r\n", name, value));
        }
        head.push_str("\r\n");
        let _ = stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(body.as_bytes()));
    }

    fn respond_json(stream: &mut TcpStream, status: &str, body: serde_json::Value) {
        respond(stream, status, &[("Content-Type", "application/json".to_string())], &body.to_string());
    }

    fn form_map(text: &str) -> HashMap<String, String> {
        url::form_urlencoded::parse(text.as_bytes()).into_owned().collect()
    }

    fn issue_tokens(s: &mut MockState) -> serde_json::Value {
        s.next_id += 1;
        let access = format!("access-{}", s.next_id);
        s.valid_access.insert(access.clone());
        let mut body = serde_json::json!({ "access_token": access, "token_type": "Bearer" });
        if let Some(seconds) = s.expires_in {
            body["expires_in"] = seconds.into();
        }
        if s.issue_refresh {
            let refresh = format!("refresh-{}", s.next_id);
            s.valid_refresh.insert(refresh.clone());
            body["refresh_token"] = refresh.into();
        }
        body
    }

    fn handle_token(s: &mut MockState, stream: &mut TcpStream, headers: &HashMap<String, String>, body: &str) {
        let form = form_map(body);
        s.token_requests.push(form.clone());
        s.token_auth_headers.push(headers.get("authorization").cloned());
        let grant = form.get("grant_type").cloned().unwrap_or_default();
        if grant == "refresh_token" {
            if let Some((status, text)) = s.refresh_failure {
                let line = format!("{} Error", status);
                respond(stream, &line, &[("Content-Type", "application/json".to_string())], text);
                return;
            }
            let token = form.get("refresh_token").cloned().unwrap_or_default();
            // refresh token ใช้ได้ครั้งเดียว ตัวเก่าถูกส่งซ้ำ = ล้มเหลว
            if !s.valid_refresh.remove(&token) {
                respond_json(stream, "400 Bad Request", serde_json::json!({ "error": "invalid_grant" }));
                return;
            }
            let tokens = issue_tokens(s);
            respond_json(stream, "200 OK", tokens);
            return;
        }
        if let Some((status, text)) = s.token_failure {
            let line = format!("{} Error", status);
            respond(stream, &line, &[("Content-Type", "application/json".to_string())], text);
            return;
        }
        let code = form.get("code").cloned().unwrap_or_default();
        let Some((challenge, redirect_uri, client_id)) = s.codes.remove(&code) else {
            respond_json(stream, "400 Bad Request", serde_json::json!({ "error": "invalid_grant" }));
            return;
        };
        let verifier = form.get("code_verifier").cloned().unwrap_or_default();
        let client_ok = match s.clients.get(&client_id).and_then(|(_, secret)| secret.as_ref()) {
            None => form.get("client_id") == Some(&client_id),
            Some(secret) => form.get("client_secret") == Some(secret) || headers.contains_key("authorization"),
        };
        if pkce_challenge(&verifier) != challenge || form.get("redirect_uri") != Some(&redirect_uri) || !client_ok {
            respond_json(stream, "400 Bad Request", serde_json::json!({ "error": "invalid_grant" }));
            return;
        }
        let tokens = issue_tokens(s);
        respond_json(stream, "200 OK", tokens);
    }

    fn handle(state: &Arc<Mutex<MockState>>, mut stream: TcpStream) {
        let Some((method, target, headers, body)) = read_request(&mut stream) else {
            return;
        };
        let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
        let mut s = state.lock().unwrap();
        let origin = format!("http://127.0.0.1:{}", s.port);
        let stream = &mut stream;
        match (method.as_str(), path) {
            ("POST", "/mcp") | ("POST", "/mcp/redirect") => {
                let auth = headers.get("authorization").cloned();
                s.mcp_auth_headers.push(auth.clone());
                let valid = !s.rejects_all_access
                    && auth.as_deref().and_then(|a| a.strip_prefix("Bearer ")).is_some_and(|t| s.valid_access.contains(t));
                if path == "/mcp/redirect" {
                    respond(stream, "302 Found", &[("Location", format!("{}/leak", origin))], "");
                } else if valid {
                    respond_json(stream, "200 OK", serde_json::json!({ "jsonrpc": "2.0", "id": 1, "result": {} }));
                } else {
                    let scope = s.challenge_scope.map(|v| format!(", scope=\"{}\"", v)).unwrap_or_default();
                    let header = format!("Bearer realm=\"mock\", resource_metadata=\"{}/.well-known/oauth-protected-resource/mcp\"{}", origin, scope);
                    respond(stream, "401 Unauthorized", &[("WWW-Authenticate", header)], "");
                }
            }
            ("POST", "/leak") | ("GET", "/leak") => {
                s.leaked_requests += 1;
                respond(stream, "200 OK", &[], "");
            }
            ("GET", "/.well-known/oauth-protected-resource/mcp") => {
                let resource = s.resource.clone().unwrap_or_else(|| format!("{}/mcp", origin));
                let mut doc = serde_json::json!({ "resource": resource, "authorization_servers": [origin] });
                if let Some(scopes) = &s.resource_scopes {
                    doc["scopes_supported"] = serde_json::json!(scopes);
                }
                respond_json(stream, "200 OK", doc);
            }
            ("GET", "/.well-known/oauth-authorization-server") => {
                let mut doc = serde_json::json!({
                    "issuer": s.metadata_issuer.clone().unwrap_or_else(|| origin.clone()),
                    "authorization_endpoint": s.authorization_endpoint.clone().unwrap_or_else(|| format!("{}/authorize", origin)),
                    "token_endpoint": format!("{}/token", origin),
                    "response_types_supported": ["code"],
                });
                if s.registration_enabled {
                    doc["registration_endpoint"] = format!("{}/register", origin).into();
                }
                if let Some(methods) = &s.pkce_methods {
                    doc["code_challenge_methods_supported"] = serde_json::json!(methods);
                }
                if let Some(methods) = &s.auth_methods {
                    doc["token_endpoint_auth_methods_supported"] = serde_json::json!(methods);
                }
                if let Some(scopes) = &s.as_scopes {
                    doc["scopes_supported"] = serde_json::json!(scopes);
                }
                if s.advertise_iss {
                    doc["authorization_response_iss_parameter_supported"] = true.into();
                }
                respond_json(stream, "200 OK", doc);
            }
            ("POST", "/register") => {
                let request: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
                s.registrations.push(request.clone());
                s.next_id += 1;
                let client_id = format!("client-{}", s.next_id);
                let method = request["token_endpoint_auth_method"].as_str().unwrap_or("none").to_string();
                let secret = (method != "none").then(|| format!("secret-{}", s.next_id));
                let redirect_uris: Vec<String> = request["redirect_uris"]
                    .as_array()
                    .map(|list| list.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                s.clients.insert(client_id.clone(), (redirect_uris, secret.clone()));
                let mut reply = serde_json::json!({ "client_id": client_id, "token_endpoint_auth_method": method });
                if let Some(secret) = secret {
                    reply["client_secret"] = secret.into();
                    reply["client_secret_expires_at"] = 0.into();
                }
                respond_json(stream, "201 Created", reply);
            }
            ("GET", "/authorize") => {
                let params = form_map(query);
                s.authorize_requests.push(params.clone());
                let client_id = params.get("client_id").cloned().unwrap_or_default();
                let redirect_uri = params.get("redirect_uri").cloned().unwrap_or_default();
                // ตรวจ redirect_uri ตรงตัวทั้งพอร์ตเหมือน server ที่เข้มงวด
                let known = s.clients.get(&client_id).is_some_and(|(uris, _)| uris.contains(&redirect_uri));
                if !known {
                    respond(stream, "400 Bad Request", &[], "invalid client or redirect_uri");
                    return;
                }
                s.next_id += 1;
                let code = format!("code-{}", s.next_id);
                let challenge = params.get("code_challenge").cloned().unwrap_or_default();
                s.codes.insert(code.clone(), (challenge, redirect_uri.clone(), client_id));
                let mut location = url::Url::parse(&redirect_uri).unwrap();
                {
                    let mut pairs = location.query_pairs_mut();
                    match s.authorize_error {
                        Some(error) => {
                            pairs.append_pair("error", error).append_pair("error_description", "<script>alert(1)</script>");
                        }
                        None => {
                            pairs.append_pair("code", &code);
                        }
                    }
                    pairs.append_pair("state", params.get("state").map(String::as_str).unwrap_or_default());
                    match s.iss_mode {
                        IssMode::Correct => {
                            pairs.append_pair("iss", &origin);
                        }
                        IssMode::Wrong => {
                            pairs.append_pair("iss", "https://attacker.example");
                        }
                        IssMode::Absent => {}
                    }
                }
                respond(stream, "302 Found", &[("Location", location.to_string())], "");
            }
            ("POST", "/token") => handle_token(&mut s, stream, &headers, &body),
            _ => respond(stream, "404 Not Found", &[], ""),
        }
    }

    impl MockServer {
        fn start() -> MockServer {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            let state = Arc::new(Mutex::new(MockState {
                port,
                advertise_iss: true,
                iss_mode: IssMode::Correct,
                pkce_methods: Some(vec!["S256"]),
                metadata_issuer: None,
                authorization_endpoint: None,
                registration_enabled: true,
                auth_methods: Some(vec!["none"]),
                resource: None,
                as_scopes: None,
                resource_scopes: Some(vec!["files:read"]),
                challenge_scope: None,
                expires_in: Some(3600),
                issue_refresh: true,
                refresh_failure: None,
                token_failure: None,
                authorize_error: None,
                rejects_all_access: false,
                registrations: Vec::new(),
                authorize_requests: Vec::new(),
                token_requests: Vec::new(),
                token_auth_headers: Vec::new(),
                mcp_auth_headers: Vec::new(),
                leaked_requests: 0,
                next_id: 0,
                clients: HashMap::new(),
                codes: HashMap::new(),
                valid_access: HashSet::new(),
                valid_refresh: HashSet::new(),
            }));
            let shared = state.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let shared = shared.clone();
                    std::thread::spawn(move || handle(&shared, stream));
                }
            });
            MockServer { port, state }
        }

        fn url(&self) -> String {
            format!("http://127.0.0.1:{}/mcp", self.port)
        }

        fn origin(&self) -> String {
            format!("http://127.0.0.1:{}", self.port)
        }

        fn set(&self, change: impl FnOnce(&mut MockState)) {
            change(&mut self.state.lock().unwrap());
        }

        fn read<T>(&self, get: impl FnOnce(&MockState) -> T) -> T {
            get(&self.state.lock().unwrap())
        }
    }

    fn pages() -> OauthPages {
        OauthPages { success: "signed-in-page".to_string(), failure: "failed-page".to_string() }
    }

    fn http_get(url: &str) -> (u16, String) {
        let agent = ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(10)).build();
        match agent.get(url).call() {
            Ok(r) | Err(ureq::Error::Status(_, r)) => {
                let status = r.status();
                (status, r.into_string().unwrap_or_default())
            }
            Err(e) => panic!("GET {} failed: {}", url, e),
        }
    }

    fn redirect_location(auth_url: &str) -> String {
        let agent = ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(10)).build();
        let response = match agent.get(auth_url).call() {
            Ok(r) | Err(ureq::Error::Status(_, r)) => r,
            Err(e) => panic!("GET {} failed: {}", auth_url, e),
        };
        response.header("location").unwrap_or_else(|| panic!("no redirect from {}", auth_url)).to_string()
    }

    fn with_param(url: &str, name: &str, value: Option<&str>) -> String {
        let mut parsed = url::Url::parse(url).unwrap();
        let kept: Vec<(String, String)> = parsed.query_pairs().into_owned().filter(|(k, _)| k != name).collect();
        {
            let mut pairs = parsed.query_pairs_mut();
            pairs.clear();
            for (k, v) in &kept {
                pairs.append_pair(k, v);
            }
            if let Some(value) = value {
                pairs.append_pair(name, value);
            }
        }
        parsed.to_string()
    }

    /// เบราว์เซอร์จำลอง: เปิดหน้า authorize แล้วขอ URL ที่ `visits` สร้างจาก redirect ของ server ทีละตัว
    fn login_with(
        server: &MockServer,
        store: &dyn OauthStore,
        key: &str,
        extra_scope: Option<&str>,
        timeout: Duration,
        visits: impl Fn(String) -> Vec<String> + Send + Sync + 'static,
    ) -> (Result<OauthStatus, String>, Arc<Mutex<Vec<(u16, String)>>>) {
        let seen: Arc<Mutex<Vec<(u16, String)>>> = Arc::default();
        let visits = Arc::new(visits);
        let cancel = AtomicBool::new(false);
        let opened = seen.clone();
        let result = oauth_login_flow(store, key, &server.url(), extra_scope, &pages(), &cancel, timeout, &|auth_url: &str| {
            let auth_url = auth_url.to_string();
            let visits = visits.clone();
            let seen = opened.clone();
            std::thread::spawn(move || {
                for target in visits(redirect_location(&auth_url)) {
                    let page = http_get(&target);
                    seen.lock().unwrap().push(page);
                }
            });
            Ok(())
        });
        (result, seen)
    }

    fn login(server: &MockServer, store: &dyn OauthStore, key: &str) -> OauthStatus {
        login_with(server, store, key, None, Duration::from_secs(10), |target| vec![target]).0.unwrap()
    }

    fn post(server: &MockServer, store: &dyn OauthStore, key: &str) -> HttpResponse {
        mcp_http_post(store, &server.url(), &HashMap::new(), "{}", Some(5_000), Some(key)).unwrap()
    }

    fn sample_record(server: &MockServer) -> OauthRecord {
        OauthRecord {
            resource: server.url(),
            issuer: server.origin(),
            token_endpoint: format!("{}/token", server.origin()),
            client: OauthClient {
                client_id: "client-0".to_string(),
                client_secret: None,
                auth_method: "none".to_string(),
                redirect_uri: "http://127.0.0.1:1/callback".to_string(),
                registered_scope: None,
                secret_expires_at: None,
            },
            client_stale: false,
            access_token: Some("stale-access".to_string()),
            refresh_token: Some("refresh-seed".to_string()),
            expires_at: Some(now_secs() - 10),
            scope: None,
        }
    }

    #[test]
    fn login_follows_the_spec_end_to_end() {
        let server = MockServer::start();
        let store = MemoryStore::default();

        // ยังไม่ล็อกอิน: ส่งแบบไม่มี token แล้วได้ 401 พร้อม challenge
        let before = post(&server, &store, "srv");
        assert_eq!(before.status, 401);
        let challenge = before.auth_challenge.unwrap();
        assert_eq!(challenge.resource_metadata.unwrap(), format!("{}/.well-known/oauth-protected-resource/mcp", server.origin()));
        assert_eq!(server.read(|s| s.mcp_auth_headers.clone()), vec![None]);

        let (result, pages_seen) = login_with(&server, &store, "srv", None, Duration::from_secs(10), |target| vec![target]);
        let status = result.unwrap();
        assert!(status.signed_in && status.can_refresh);
        assert_eq!(status.issuer.as_deref(), Some(server.origin().as_str()));
        std::thread::sleep(Duration::from_millis(100));
        let shown = pages_seen.lock().unwrap().clone();
        assert_eq!(shown[0].0, 200);
        assert!(shown[0].1.contains("signed-in-page"));

        // ลงทะเบียนเป็น native app พร้อม redirect แบบ 127.0.0.1
        let registration = server.read(|s| s.registrations[0].clone());
        assert_eq!(registration["application_type"], "native");
        assert_eq!(registration["grant_types"], serde_json::json!(["authorization_code", "refresh_token"]));
        let redirect_uri = registration["redirect_uris"][0].as_str().unwrap().to_string();
        assert!(redirect_uri.starts_with("http://127.0.0.1:"), "{}", redirect_uri);
        assert!(redirect_uri.ends_with("/callback"));

        // authorization request มี PKCE, state, resource และ scope จาก scopes_supported
        let auth = server.read(|s| s.authorize_requests[0].clone());
        assert_eq!(auth["response_type"], "code");
        assert_eq!(auth["code_challenge_method"], "S256");
        assert_eq!(auth["resource"], server.url());
        assert_eq!(auth["scope"], "files:read");
        assert!(auth["state"].len() >= 32);
        assert_eq!(auth["redirect_uri"], redirect_uri);

        // token request มี verifier ที่ตรงกับ challenge และ resource ด้วย
        let token = server.read(|s| s.token_requests[0].clone());
        assert_eq!(token["grant_type"], "authorization_code");
        assert_eq!(pkce_challenge(&token["code_verifier"]), auth["code_challenge"]);
        assert_eq!(token["resource"], server.url());

        // หลังล็อกอิน Rust ใส่ header ให้เองโดย TS ไม่ต้องส่งอะไรมา
        let after = post(&server, &store, "srv");
        assert_eq!(after.status, 200);
        let header = server.read(|s| s.mcp_auth_headers.last().cloned().flatten()).unwrap();
        assert!(header.starts_with("Bearer access-"), "{}", header);
        // ของที่ webview ได้รับต้องไม่มี token
        let status_json = serde_json::to_string(&status).unwrap();
        assert!(!status_json.contains("access-") && !status_json.contains("refresh-"), "{}", status_json);
    }

    #[test]
    fn callback_with_a_wrong_or_missing_state_is_discarded() {
        let server = MockServer::start();
        let store = MemoryStore::default();
        let (result, pages_seen) = login_with(&server, &store, "srv", None, Duration::from_secs(10), |target| {
            vec![
                with_param(&target, "state", Some("forged")),
                with_param(&target, "state", None),
                with_param(&with_param(&target, "code", Some("attacker-code")), "state", Some("forged")),
                target,
            ]
        });
        // request ปลอมไม่ทำให้การล็อกอินจริงล้ม
        assert!(result.unwrap().signed_in);
        std::thread::sleep(Duration::from_millis(100));
        let seen = pages_seen.lock().unwrap().clone();
        assert_eq!(seen.iter().map(|(status, _)| *status).collect::<Vec<_>>(), vec![400, 400, 400, 200]);
        assert!(seen[0].1.contains("failed-page"));
        // code จาก request ปลอมไม่เคยถูกส่งไปแลก token
        let tokens = server.read(|s| s.token_requests.clone());
        assert_eq!(tokens.len(), 1);
        assert_ne!(tokens[0]["code"], "attacker-code");
    }

    #[test]
    fn a_wrong_state_alone_never_produces_a_token() {
        let server = MockServer::start();
        let store = MemoryStore::default();
        let (result, _) = login_with(&server, &store, "srv", None, Duration::from_millis(800), |target| {
            vec![with_param(&target, "state", Some("forged"))]
        });
        assert_eq!(result.unwrap_err(), OAUTH_ERR_TIMEOUT);
        assert!(server.read(|s| s.token_requests.is_empty()));
        assert!(oauth_load(&store, "srv").unwrap().is_none());
        assert_eq!(post(&server, &store, "srv").status, 401);
    }

    #[test]
    fn listener_only_accepts_get_callback_on_its_own_host() {
        let listener = bind_oauth_listener(None).unwrap();
        let addr = listener.local_addr().unwrap();
        assert_eq!(addr.ip().to_string(), "127.0.0.1");

        let cancel = AtomicBool::new(false);
        let send = |raw: String| {
            let mut stream = TcpStream::connect(addr).unwrap();
            stream.write_all(raw.as_bytes()).unwrap();
            let mut reply = String::new();
            let _ = stream.read_to_string(&mut reply);
            reply
        };
        let host = format!("127.0.0.1:{}", addr.port());
        let replies = std::thread::scope(|scope| {
            let waiter = scope.spawn(|| wait_for_oauth_callback(&listener, "good", &cancel, Duration::from_secs(5), "failed-page").map(|c| c.code));
            let replies = vec![
                send(format!("GET /callback?state=good&code=x HTTP/1.1\r\nHost: evil.example\r\n\r\n")),
                send(format!("POST /callback?state=good&code=x HTTP/1.1\r\nHost: {}\r\n\r\n", host)),
                send(format!("GET /favicon.ico HTTP/1.1\r\nHost: {}\r\n\r\n", host)),
            ];
            // ต้องรอต่อหลังเจอ request ที่ไม่ผ่าน
            let accepted = TcpStream::connect(addr).map(|mut stream| {
                stream.write_all(format!("GET /callback?state=good&code=real HTTP/1.1\r\nHost: {}\r\n\r\n", host).as_bytes()).unwrap();
                stream
            });
            assert_eq!(waiter.join().unwrap().unwrap().as_deref(), Some("real"));
            drop(accepted);
            replies
        });
        assert!(replies[0].starts_with("HTTP/1.1 403"), "{}", replies[0]);
        assert!(replies[1].starts_with("HTTP/1.1 404"), "{}", replies[1]);
        assert!(replies[2].starts_with("HTTP/1.1 404"), "{}", replies[2]);
    }

    #[test]
    fn cancelling_stops_waiting_for_the_browser() {
        let listener = bind_oauth_listener(None).unwrap();
        let cancel = AtomicBool::new(false);
        let started = std::time::Instant::now();
        let error = std::thread::scope(|scope| {
            let waiter = scope.spawn(|| wait_for_oauth_callback(&listener, "s", &cancel, Duration::from_secs(30), "x").err());
            std::thread::sleep(Duration::from_millis(100));
            cancel.store(true, std::sync::atomic::Ordering::SeqCst);
            waiter.join().unwrap()
        });
        assert_eq!(error.as_deref(), Some(OAUTH_ERR_CANCELLED));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn issuer_in_the_callback_is_checked_before_the_code_is_used() {
        for (advertised, mode, accepted) in [
            (true, IssMode::Correct, true),
            (true, IssMode::Wrong, false),
            (true, IssMode::Absent, false),
            (false, IssMode::Correct, true),
            (false, IssMode::Wrong, false),
            (false, IssMode::Absent, true),
        ] {
            let server = MockServer::start();
            server.set(|s| {
                s.advertise_iss = advertised;
                s.iss_mode = mode;
            });
            let store = MemoryStore::default();
            let (result, _) = login_with(&server, &store, "srv", None, Duration::from_secs(10), |target| vec![target]);
            assert_eq!(result.is_ok(), accepted);
            if !accepted {
                assert_eq!(result.unwrap_err(), OAUTH_ERR_ISSUER);
                assert!(server.read(|s| s.token_requests.is_empty()), "code must not reach the token endpoint");
                assert!(oauth_load(&store, "srv").unwrap().is_none());
            }
        }
    }

    #[test]
    fn error_from_the_authorization_server_is_reported_after_the_issuer_check() {
        let server = MockServer::start();
        server.set(|s| s.authorize_error = Some("access_denied"));
        let store = MemoryStore::default();
        let (result, pages_seen) = login_with(&server, &store, "srv", None, Duration::from_secs(10), |target| vec![target]);
        assert!(result.unwrap_err().starts_with(OAUTH_ERR_DENIED));
        std::thread::sleep(Duration::from_millis(100));
        // ข้อความจาก server ไม่ถูกสะท้อนลงหน้าเว็บบน loopback
        let seen = pages_seen.lock().unwrap().clone();
        assert!(seen[0].1.contains("failed-page") && !seen[0].1.contains("<script>"), "{}", seen[0].1);

        // iss ไม่ตรง: ห้ามแสดง error ของ response นั้นตามสเปก
        let server = MockServer::start();
        server.set(|s| {
            s.authorize_error = Some("access_denied");
            s.iss_mode = IssMode::Wrong;
        });
        let (result, _) = login_with(&server, &store, "srv", None, Duration::from_secs(10), |target| vec![target]);
        assert_eq!(result.unwrap_err(), OAUTH_ERR_ISSUER);
    }

    fn login_error(server: &MockServer) -> String {
        let store = MemoryStore::default();
        let opened = Arc::new(AtomicBool::new(false));
        let flag = opened.clone();
        let cancel = AtomicBool::new(false);
        let error = oauth_login_flow(&store, "srv", &server.url(), None, &pages(), &cancel, Duration::from_secs(5), &|_: &str| {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        })
        .err()
        .expect("login must fail");
        assert!(!opened.load(std::sync::atomic::Ordering::SeqCst), "browser must not open: {}", error);
        assert!(oauth_load(&store, "srv").unwrap().is_none());
        error
    }

    #[test]
    fn metadata_with_a_different_issuer_is_not_used() {
        let server = MockServer::start();
        server.set(|s| s.metadata_issuer = Some("https://honest.example".to_string()));
        assert_eq!(login_error(&server), OAUTH_ERR_NO_AS_METADATA);
    }

    #[test]
    fn refuses_to_continue_without_pkce_s256() {
        for methods in [None, Some(vec!["plain"])] {
            let server = MockServer::start();
            server.set(|s| s.pkce_methods = methods);
            assert_eq!(login_error(&server), OAUTH_ERR_NO_PKCE);
        }
    }

    #[test]
    fn dangerous_authorization_endpoints_never_reach_the_browser() {
        for endpoint in ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "ms-msdt:/id", "http://evil.example/authorize", "https://user:pw@evil.example/a", "not a url"] {
            let server = MockServer::start();
            server.set(|s| s.authorization_endpoint = Some(endpoint.to_string()));
            assert!(login_error(&server).starts_with(OAUTH_ERR_INSECURE_ENDPOINT), "{}", endpoint);
        }
    }

    #[test]
    fn resource_metadata_must_cover_the_server_url() {
        let server = MockServer::start();
        server.set(|s| s.resource = Some("https://other.example/mcp".to_string()));
        assert!(login_error(&server).starts_with(OAUTH_ERR_RESOURCE_MISMATCH));
    }

    #[test]
    fn server_without_registration_reports_it_honestly() {
        let server = MockServer::start();
        server.set(|s| s.registration_enabled = false);
        assert_eq!(login_error(&server), OAUTH_ERR_NO_REGISTRATION);
    }

    #[test]
    fn plain_http_servers_cannot_use_oauth() {
        assert!(oauth_server_url("http://mcp.example.com/mcp").is_err());
        assert!(oauth_server_url("https://user:pw@mcp.example.com/mcp").is_err());
        assert!(oauth_server_url("ftp://mcp.example.com/").is_err());
        assert!(oauth_server_url("https://mcp.example.com/mcp").is_ok());
        assert!(oauth_server_url("http://127.0.0.1:9999/mcp").is_ok());
    }

    #[test]
    fn discovered_urls_cannot_point_inside_the_network_from_a_remote_server() {
        let remote = url::Url::parse("https://mcp.example.com/mcp").unwrap();
        for bad in [
            "http://auth.example.com/token",
            "https://127.0.0.1/token",
            "https://localhost/token",
            "https://192.168.1.1/token",
            "https://169.254.169.254/latest/meta-data",
            "https://[::1]/token",
            "https://[::ffff:127.0.0.1]/token",
            "https://auth.example.com/token#fragment",
            "file:///etc/passwd",
        ] {
            assert!(oauth_url_allowed(&remote, bad).is_err(), "{}", bad);
        }
        assert!(oauth_url_allowed(&remote, "https://auth.example.com/token").is_ok());
        // http ใช้ได้เฉพาะตอน server เองอยู่ในเครื่อง (ทดสอบกับ mock)
        let local = url::Url::parse("http://127.0.0.1:9/mcp").unwrap();
        assert!(oauth_url_allowed(&local, "http://127.0.0.1:9/token").is_ok());
        assert!(oauth_url_allowed(&local, "http://evil.example/token").is_err());
    }

    #[test]
    fn expired_token_is_refreshed_before_the_request() {
        let server = MockServer::start();
        let store = MemoryStore::default();
        login(&server, &store, "srv");
        let mut record = oauth_load(&store, "srv").unwrap().unwrap();
        let old_access = record.access_token.clone().unwrap();
        let old_refresh = record.refresh_token.clone().unwrap();
        record.expires_at = Some(now_secs() - 1);
        oauth_save(&store, "srv", &record).unwrap();

        assert_eq!(post(&server, &store, "srv").status, 200);
        let refresh = server.read(|s| s.token_requests.last().cloned().unwrap());
        assert_eq!(refresh["grant_type"], "refresh_token");
        assert_eq!(refresh["refresh_token"], old_refresh);
        assert_eq!(refresh["resource"], server.url());
        // request แรกหลังหมดอายุใช้ token ใหม่ ไม่ได้ส่งตัวเก่าออกไป
        let header = server.read(|s| s.mcp_auth_headers.last().cloned().flatten()).unwrap();
        assert_ne!(header, format!("Bearer {}", old_access));
        // refresh token ที่หมุนมาใหม่ถูกบันทึก
        let saved = oauth_load(&store, "srv").unwrap().unwrap();
        assert_ne!(saved.refresh_token.unwrap(), old_refresh);
        assert!(saved.expires_at.unwrap() > now_secs());
    }

    #[test]
    fn token_expiring_within_the_leeway_is_refreshed_early() {
        let server = MockServer::start();
        let store = MemoryStore::default();
        login(&server, &store, "srv");
        let mut record = oauth_load(&store, "srv").unwrap().unwrap();
        record.expires_at = Some(now_secs() + OAUTH_EXPIRY_LEEWAY_SECS / 2);
        oauth_save(&store, "srv", &record).unwrap();
        post(&server, &store, "srv");
        assert_eq!(server.read(|s| s.token_requests.last().cloned().unwrap())["grant_type"], "refresh_token");
    }

    #[test]
    fn expired_token_without_refresh_needs_a_new_login() {
        let server = MockServer::start();
        let store = MemoryStore::default();
        server.set(|s| s.issue_refresh = false);
        login(&server, &store, "srv");
        let mut record = oauth_load(&store, "srv").unwrap().unwrap();
        record.expires_at = Some(now_secs() - 1);
        oauth_save(&store, "srv", &record).unwrap();
        assert!(!oauth_status_of(&store, "srv", &server.url()).unwrap().signed_in);

        let response = post(&server, &store, "srv");
        assert_eq!(response.status, 401);
        assert_eq!(server.read(|s| s.mcp_auth_headers.last().cloned().flatten()), None);
        assert!(oauth_load(&store, "srv").unwrap().unwrap().access_token.is_none());
    }

    #[test]
    fn rejected_refresh_token_clears_the_login() {
        let server = MockServer::start();
        let store = MemoryStore::default();
        login(&server, &store, "srv");
        let mut record = oauth_load(&store, "srv").unwrap().unwrap();
        record.expires_at = Some(now_secs() - 1);
        oauth_save(&store, "srv", &record).unwrap();
        server.set(|s| s.refresh_failure = Some((400, r#"{"error":"invalid_grant"}"#)));

        let response = post(&server, &store, "srv");
        assert_eq!(response.status, 401);
        assert!(response.auth_challenge.is_some());
        assert_eq!(server.read(|s| s.mcp_auth_headers.last().cloned().flatten()), None);
        let saved = oauth_load(&store, "srv").unwrap().unwrap();
        assert!(saved.access_token.is_none() && saved.refresh_token.is_none());
        assert!(!oauth_status_of(&store, "srv", &server.url()).unwrap().signed_in);
    }

    #[test]
    fn temporary_refresh_failure_keeps_the_login() {
        for failure in [(503, "unavailable"), (403, "<html>blocked</html>"), (429, "{}")] {
            let server = MockServer::start();
            let store = MemoryStore::default();
            login(&server, &store, "srv");
            let mut record = oauth_load(&store, "srv").unwrap().unwrap();
            record.expires_at = Some(now_secs() - 1);
            oauth_save(&store, "srv", &record).unwrap();
            let refresh_before = record.refresh_token.clone();
            server.set(|s| s.refresh_failure = Some(failure));

            let error = mcp_http_post(&store, &server.url(), &HashMap::new(), "{}", Some(5_000), Some("srv")).err().unwrap();
            assert!(error.starts_with(OAUTH_ERR_REFRESH), "{}", error);
            assert_eq!(oauth_load(&store, "srv").unwrap().unwrap().refresh_token, refresh_before);

            // server กลับมาแล้วใช้ต่อได้โดยไม่ต้องล็อกอินใหม่
            server.set(|s| s.refresh_failure = None);
            assert_eq!(post(&server, &store, "srv").status, 200);
        }
    }

    #[test]
    fn revoked_token_is_refreshed_once_and_the_request_retried() {
        let server = MockServer::start();
        let store = MemoryStore::default();
        login(&server, &store, "srv");
        let current = oauth_load(&store, "srv").unwrap().unwrap().access_token.unwrap();
        server.set(|s| {
            s.valid_access.remove(&current);
            // ลืม request ตอนล็อกอิน เทสต์นี้ดูเฉพาะ request หลังจากนี้
            s.mcp_auth_headers.clear();
        });
        assert_eq!(post(&server, &store, "srv").status, 200);
        let headers = server.read(|s| s.mcp_auth_headers.clone());
        assert_eq!(headers.len(), 2);
        assert_eq!(headers[0].as_deref(), Some(format!("Bearer {}", current).as_str()));
        assert_ne!(headers[0], headers[1]);

        // server ไม่รับ token ใหม่ด้วย: ไม่วนลูป คืน 401 ให้ผู้ใช้ล็อกอินใหม่
        server.set(|s| s.rejects_all_access = true);
        let before = server.read(|s| s.mcp_auth_headers.len());
        assert_eq!(post(&server, &store, "srv").status, 401);
        assert_eq!(server.read(|s| s.mcp_auth_headers.len()), before + 2);
    }

    #[test]
    fn concurrent_requests_share_one_refresh() {
        let server = MockServer::start();
        let store = MemoryStore::default();
        login(&server, &store, "srv");
        let mut record = oauth_load(&store, "srv").unwrap().unwrap();
        record.expires_at = Some(now_secs() - 1);
        oauth_save(&store, "srv", &record).unwrap();
        let statuses: Vec<u16> = std::thread::scope(|scope| {
            let workers: Vec<_> = (0..6).map(|_| scope.spawn(|| post(&server, &store, "srv").status)).collect();
            workers.into_iter().map(|w| w.join().unwrap()).collect()
        });
        assert_eq!(statuses, vec![200; 6]);
        let refreshes = server.read(|s| s.token_requests.iter().filter(|t| t["grant_type"] == "refresh_token").count());
        assert_eq!(refreshes, 1);
    }

    #[test]
    fn token_is_only_sent_to_its_own_resource() {
        let server = MockServer::start();
        let other = MockServer::start();
        let store = MemoryStore::default();
        login(&server, &store, "srv");

        // config ถูกแก้ให้ชี้ไป server อื่นโดยใช้ชื่อเดิม
        let response = mcp_http_post(&store, &other.url(), &HashMap::new(), "{}", Some(5_000), Some("srv")).unwrap();
        assert_eq!(response.status, 401);
        assert_eq!(other.read(|s| s.mcp_auth_headers.clone()), vec![None]);
        assert!(!oauth_status_of(&store, "srv", &other.url()).unwrap().signed_in);

        // path อื่นบน server เดิมที่ไม่อยู่ใต้ resource ก็ไม่ได้ token เช่นกัน
        let sibling = format!("{}/not-mcp", server.origin());
        mcp_http_post(&store, &sibling, &HashMap::new(), "{}", Some(5_000), Some("srv")).unwrap();
        let resource = url::Url::parse(&server.url()).unwrap();
        assert!(resource_covers(&resource, &url::Url::parse(&format!("{}?read_only=true", server.url())).unwrap()));
        assert!(resource_covers(&resource, &url::Url::parse(&format!("{}/sub", server.url())).unwrap()));
        assert!(!resource_covers(&resource, &url::Url::parse(&format!("{}-other", server.url())).unwrap()));
        assert!(!resource_covers(&resource, &url::Url::parse(&sibling).unwrap()));
    }

    #[test]
    fn token_does_not_follow_redirects() {
        let server = MockServer::start();
        let store = MemoryStore::default();
        login(&server, &store, "srv");
        let target = format!("{}/redirect", server.url());
        let response = mcp_http_post(&store, &target, &HashMap::new(), "{}", Some(5_000), Some("srv")).unwrap();
        assert_eq!(response.status, 302);
        assert_eq!(server.read(|s| s.leaked_requests), 0);
    }

    #[test]
    fn oauth_servers_ignore_a_static_authorization_header() {
        let server = MockServer::start();
        let store = MemoryStore::default();
        login(&server, &store, "srv");
        let headers = HashMap::from([("authorization".to_string(), "Bearer from-config".to_string())]);
        assert_eq!(mcp_http_post(&store, &server.url(), &headers, "{}", Some(5_000), Some("srv")).unwrap().status, 200);
        let sent = server.read(|s| s.mcp_auth_headers.last().cloned().flatten()).unwrap();
        assert!(sent.starts_with("Bearer access-"), "{}", sent);

        // server ที่ไม่ได้ตั้ง OAuth ยังใช้ header ของ config ตามเดิม
        mcp_http_post(&store, &server.url(), &headers, "{}", Some(5_000), None).unwrap();
        assert_eq!(server.read(|s| s.mcp_auth_headers.last().cloned().flatten()).unwrap(), "Bearer from-config");
    }

    #[test]
    fn logout_removes_every_stored_part() {
        let server = MockServer::start();
        let store = MemoryStore::default();
        login(&server, &store, "srv");
        // token ยาวเก็บหลายรายการ
        let mut record = oauth_load(&store, "srv").unwrap().unwrap();
        record.access_token = Some("x".repeat(20_000));
        oauth_save(&store, "srv", &record).unwrap();
        assert!(store.items.lock().unwrap().len() > 5);
        // ของ server อื่นต้องไม่หายไปด้วย
        oauth_save(&store, "other", &sample_record(&server)).unwrap();

        oauth_delete(&store, "srv").unwrap();
        assert!(oauth_load(&store, "srv").unwrap().is_none());
        assert!(store.items.lock().unwrap().keys().all(|name| !name.starts_with("mcp-oauth.srv.")));
        assert!(oauth_load(&store, "other").unwrap().is_some());
        assert_eq!(post(&server, &store, "srv").status, 401);
        assert_eq!(server.read(|s| s.mcp_auth_headers.last().cloned().flatten()), None);
        // ลบซ้ำไม่ error (ถอนการติดตั้งตอนไม่ได้ล็อกอิน)
        oauth_delete(&store, "srv").unwrap();
    }

    #[test]
    fn long_tokens_are_split_and_shrinking_leaves_nothing_behind() {
        let server = MockServer::start();
        let store = MemoryStore::default();
        let mut record = sample_record(&server);
        record.access_token = Some("a".repeat(12_000));
        record.refresh_token = Some("r".repeat(6_000));
        oauth_save(&store, "srv", &record).unwrap();
        assert!(store.items.lock().unwrap().len() >= 9);
        let loaded = oauth_load(&store, "srv").unwrap().unwrap();
        assert_eq!(loaded.access_token, record.access_token);
        assert_eq!(loaded.refresh_token, record.refresh_token);

        record.access_token = Some("short".to_string());
        record.refresh_token = None;
        oauth_save(&store, "srv", &record).unwrap();
        assert_eq!(store.items.lock().unwrap().len(), 1);
        assert_eq!(oauth_load(&store, "srv").unwrap().unwrap().access_token.as_deref(), Some("short"));

        record.access_token = Some("x".repeat(OAUTH_PART_BYTES * (OAUTH_MAX_PARTS + 1)));
        assert!(oauth_save(&store, "srv", &record).is_err());
    }

    #[test]
    fn broken_vault_data_counts_as_signed_out() {
        let store = MemoryStore::default();
        store.set(&oauth_part_name("srv", 0), &[3, b'{']).unwrap();
        assert!(oauth_load(&store, "srv").unwrap().is_none());
        store.set(&oauth_part_name("srv", 0), &[1, b'{']).unwrap();
        assert!(oauth_load(&store, "srv").unwrap().is_none());
        store.set(&oauth_part_name("srv", 0), &[]).unwrap();
        assert!(oauth_load(&store, "srv").unwrap().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn credential_manager_holds_tokens_longer_than_one_entry() {
        let key = format!("dextest-{}", uuid::Uuid::new_v4().simple());
        let server = MockServer::start();
        let store = CredentialStore;
        let mut record = sample_record(&server);
        record.access_token = Some("a".repeat(9_000));
        if let Err(error) = oauth_save(&store, &key, &record) {
            // เครื่อง CI บางแบบไม่มี logon session ให้ใช้ Credential Manager
            assert!(error.contains("logon session"), "{}", error);
            eprintln!("skipped: {}", error);
            return;
        }
        let loaded = oauth_load(&store, &key);
        let deleted = oauth_delete(&store, &key);
        let after = oauth_load(&store, &key);
        assert_eq!(loaded.unwrap().unwrap().access_token, record.access_token);
        deleted.unwrap();
        assert!(after.unwrap().is_none());
        // เหตุผลที่ต้องแบ่งเก็บ: รายการเดียวรับข้อความ 2,000 ตัวอักษรไม่ได้
        let entry = keyring::Entry::new(KEYRING_SERVICE, &oauth_part_name(&key, 0)).unwrap();
        assert!(entry.set_password(&"a".repeat(2_000)).is_err());
    }

    #[test]
    fn vault_cannot_be_reached_through_the_api_key_commands() {
        let name = oauth_part_name("srv", 0);
        assert!(load_api_keys(vec![name.clone()]).is_err());
        assert!(save_api_key(name, "overwrite".to_string()).is_err());
        // `${...}` ใน config เติม prefix mcp-secret- เสมอจึงไม่ถึง vault
        assert_eq!(expand_env("${mcp-oauth.srv.0}"), "");
    }

    #[test]
    fn second_login_reuses_the_registered_client_on_the_same_port() {
        let server = MockServer::start();
        let store = MemoryStore::default();
        login(&server, &store, "srv");
        let first = oauth_load(&store, "srv").unwrap().unwrap().client;
        login(&server, &store, "srv");
        let second = oauth_load(&store, "srv").unwrap().unwrap().client;
        assert_eq!(server.read(|s| s.registrations.len()), 1);
        assert_eq!(first.client_id, second.client_id);
        assert_eq!(first.redirect_uri, second.redirect_uri);
    }

    #[test]
    fn busy_port_registers_a_new_client_instead_of_failing_the_strict_redirect_check() {
        let server = MockServer::start();
        let store = MemoryStore::default();
        login(&server, &store, "srv");
        let first = oauth_load(&store, "srv").unwrap().unwrap().client;
        let port = url::Url::parse(&first.redirect_uri).unwrap().port().unwrap();
        let _occupied = TcpListener::bind(("127.0.0.1", port)).unwrap();
        login(&server, &store, "srv");
        let second = oauth_load(&store, "srv").unwrap().unwrap().client;
        assert_eq!(server.read(|s| s.registrations.len()), 2);
        assert_ne!(first.redirect_uri, second.redirect_uri);
    }

    #[test]
    fn abandoned_login_with_a_reused_client_registers_again_next_time() {
        let server = MockServer::start();
        let store = MemoryStore::default();
        login(&server, &store, "srv");
        // ผู้ใช้ไม่กลับมาจากเบราว์เซอร์ เช่น server ลืม client แล้วแสดงหน้า error ค้างไว้
        let (result, _) = login_with(&server, &store, "srv", None, Duration::from_millis(300), |_| Vec::new());
        assert_eq!(result.unwrap_err(), OAUTH_ERR_TIMEOUT);
        // token ที่ยังใช้ได้ไม่ถูกแตะ
        assert_eq!(post(&server, &store, "srv").status, 200);
        login(&server, &store, "srv");
        assert_eq!(server.read(|s| s.registrations.len()), 2);
    }

    #[test]
    fn client_is_registered_again_when_the_authorization_server_changes() {
        let first = MockServer::start();
        let store = MemoryStore::default();
        login(&first, &store, "srv");
        let second = MockServer::start();
        login(&second, &store, "srv");
        assert_eq!(second.read(|s| s.registrations.len()), 1);
        assert_eq!(oauth_load(&store, "srv").unwrap().unwrap().issuer, second.origin());
    }

    #[test]
    fn servers_without_public_clients_get_the_secret_they_issued() {
        // แบบเดียวกับ metadata ของ Supabase: ไม่รับ `none`
        let server = MockServer::start();
        server.set(|s| s.auth_methods = Some(vec!["client_secret_basic", "client_secret_post"]));
        let store = MemoryStore::default();
        login(&server, &store, "srv");
        assert_eq!(server.read(|s| s.registrations[0]["token_endpoint_auth_method"].clone()), "client_secret_post");
        let token = server.read(|s| s.token_requests[0].clone());
        assert!(token["client_secret"].starts_with("secret-"));
        // secret อยู่ใน vault ไม่ได้อยู่ในคำตอบที่ส่งให้ webview
        let status = serde_json::to_string(&oauth_status_of(&store, "srv", &server.url()).unwrap()).unwrap();
        assert!(!status.contains("secret-"), "{}", status);

        let server = MockServer::start();
        server.set(|s| s.auth_methods = Some(vec!["client_secret_basic"]));
        let store = MemoryStore::default();
        login(&server, &store, "srv");
        let basic = server.read(|s| s.token_auth_headers[0].clone()).unwrap();
        assert!(basic.starts_with("Basic "));
        assert!(!server.read(|s| s.token_requests[0].contains_key("client_secret")));
    }

    #[test]
    fn scope_comes_from_the_challenge_first_and_step_up_keeps_what_was_granted() {
        let server = MockServer::start();
        server.set(|s| {
            s.challenge_scope = Some("read write");
            s.resource_scopes = Some(vec!["ignored"]);
            s.as_scopes = Some(vec!["read", "write", "admin", "offline_access"]);
        });
        let store = MemoryStore::default();
        login(&server, &store, "srv");
        assert_eq!(server.read(|s| s.authorize_requests[0]["scope"].clone()), "read write offline_access");

        // 403 insufficient_scope: ล็อกอินใหม่โดยขอ scope เพิ่ม ต้องลงทะเบียน client ใหม่ให้ครอบ scope ด้วย
        let (result, _) = login_with(&server, &store, "srv", Some("admin"), Duration::from_secs(10), |target| vec![target]);
        result.unwrap();
        let last = server.read(|s| s.authorize_requests.last().cloned().unwrap());
        assert_eq!(last["scope"], "read write offline_access admin");
        assert_eq!(server.read(|s| s.registrations.len()), 2);
    }

    #[test]
    fn scope_selection_order() {
        let list = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let supported = list(&["a", "b"]);
        assert_eq!(select_oauth_scope(Some("x y"), Some(&supported), None, None, None).as_deref(), Some("x y"));
        assert_eq!(select_oauth_scope(None, Some(&supported), None, None, None).as_deref(), Some("a b"));
        assert_eq!(select_oauth_scope(Some("  "), Some(&supported), None, None, None).as_deref(), Some("a b"));
        assert_eq!(select_oauth_scope(None, None, None, None, None), None);
        // ไม่มี scope อื่น: ไม่ส่ง offline_access ตัวเดียว
        assert_eq!(select_oauth_scope(None, None, Some(&list(&["offline_access"])), None, None), None);
        assert_eq!(select_oauth_scope(Some("x"), None, None, Some("old x"), Some("new")).as_deref(), Some("old x new"));
    }

    #[test]
    fn auth_method_prefers_a_public_client() {
        let list = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(choose_client_auth_method(None), "none");
        assert_eq!(choose_client_auth_method(Some(&list(&["client_secret_basic", "none"]))), "none");
        assert_eq!(choose_client_auth_method(Some(&list(&["client_secret_basic", "client_secret_post"]))), "client_secret_post");
        assert_eq!(choose_client_auth_method(Some(&list(&["client_secret_basic"]))), "client_secret_basic");
        assert_eq!(choose_client_auth_method(Some(&list(&["private_key_jwt"]))), "none");
    }

    #[test]
    fn parses_bearer_challenges_as_real_servers_send_them() {
        let notion = parse_bearer_challenge("Bearer realm=\"OAuth\", resource_metadata=\"https://mcp.notion.com/.well-known/oauth-protected-resource/mcp\", scope=\"default\"").unwrap();
        assert_eq!(notion.scope.as_deref(), Some("default"));
        assert_eq!(notion.resource_metadata.as_deref(), Some("https://mcp.notion.com/.well-known/oauth-protected-resource/mcp"));

        let figma = parse_bearer_challenge("Bearer resource_metadata=\"https://mcp.figma.com/.well-known/oauth-protected-resource\",scope=\"mcp:connect\",authorization_uri=\"https://api.figma.com/x\"").unwrap();
        assert_eq!(figma.scope.as_deref(), Some("mcp:connect"));

        let step_up = parse_bearer_challenge("bearer error=\"insufficient_scope\", scope=\"files:write files:read\", error_description=\"a, b \\\"c\\\"\"").unwrap();
        assert_eq!(step_up.error.as_deref(), Some("insufficient_scope"));
        assert_eq!(step_up.scope.as_deref(), Some("files:write files:read"));

        let unquoted = parse_bearer_challenge("Bearer error=invalid_token").unwrap();
        assert_eq!(unquoted.error.as_deref(), Some("invalid_token"));

        let spaced = parse_bearer_challenge("Bearer scope = \"a b\"").unwrap();
        assert_eq!(spaced.scope.as_deref(), Some("a b"));

        // scheme อื่นปนมา: อ่านเฉพาะของ Bearer
        let mixed = parse_bearer_challenge("Basic realm=\"x\", scope=\"wrong\", Bearer scope=\"right\", Negotiate abc==").unwrap();
        assert_eq!(mixed.scope.as_deref(), Some("right"));

        assert_eq!(parse_bearer_challenge("Bearer"), Some(AuthChallenge::default()));
        assert_eq!(parse_bearer_challenge("Basic realm=\"x\""), None);
        assert_eq!(parse_bearer_challenge(""), None);
    }

    #[test]
    fn builds_well_known_urls_in_the_order_the_spec_lists() {
        let url = |raw: &str| url::Url::parse(raw).unwrap();
        assert_eq!(
            protected_resource_candidates(&url("https://example.com/public/mcp")),
            vec!["https://example.com/.well-known/oauth-protected-resource/public/mcp", "https://example.com/.well-known/oauth-protected-resource"]
        );
        assert_eq!(protected_resource_candidates(&url("https://example.com")), vec!["https://example.com/.well-known/oauth-protected-resource"]);
        assert_eq!(
            protected_resource_candidates(&url("https://mcp.supabase.com/mcp?read_only=true"))[0],
            "https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp?read_only=true"
        );
        assert_eq!(
            authorization_server_candidates(&url("https://auth.example.com/tenant1")),
            vec![
                "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
                "https://auth.example.com/.well-known/openid-configuration/tenant1",
                "https://auth.example.com/tenant1/.well-known/openid-configuration",
            ]
        );
        assert_eq!(
            authorization_server_candidates(&url("https://auth.example.com/")),
            vec!["https://auth.example.com/.well-known/oauth-authorization-server", "https://auth.example.com/.well-known/openid-configuration"]
        );
    }

    #[test]
    fn tokens_with_control_characters_are_refused() {
        let server = MockServer::start();
        let mut record = sample_record(&server);
        let response = TokenResponse {
            access_token: Some("good\r\nX-Injected: 1".to_string()),
            token_type: Some("Bearer".to_string()),
            expires_in: None,
            refresh_token: None,
            scope: None,
            error: None,
            error_description: None,
        };
        assert!(apply_token_response(&mut record, response, 0).is_err());

        let lifetime = TokenResponse {
            access_token: Some("good".to_string()),
            token_type: Some("bearer".to_string()),
            expires_in: Some(serde_json::json!("120")),
            refresh_token: None,
            scope: None,
            error: None,
            error_description: None,
        };
        apply_token_response(&mut record, lifetime, 1000).unwrap();
        assert_eq!(record.expires_at, Some(1120));
        // ไม่ได้ refresh token ใหม่ = เก็บตัวเดิม
        assert_eq!(record.refresh_token.as_deref(), Some("refresh-seed"));

        let not_bearer = TokenResponse {
            access_token: Some("good".to_string()),
            token_type: Some("mac".to_string()),
            expires_in: None,
            refresh_token: None,
            scope: None,
            error: None,
            error_description: None,
        };
        assert!(apply_token_response(&mut record, not_bearer, 0).is_err());
    }

    #[test]
    fn invalid_client_at_the_token_endpoint_registers_again_next_time() {
        let server = MockServer::start();
        let store = MemoryStore::default();
        login(&server, &store, "srv");
        server.set(|s| s.token_failure = Some((401, r#"{"error":"invalid_client"}"#)));
        let (result, _) = login_with(&server, &store, "srv", None, Duration::from_secs(10), |target| vec![target]);
        assert!(result.unwrap_err().starts_with(OAUTH_ERR_TOKEN));
        server.set(|s| s.token_failure = None);
        login(&server, &store, "srv");
        assert_eq!(server.read(|s| s.registrations.len()), 2);
    }

    #[test]
    fn signed_in_status_follows_the_stored_record() {
        let server = MockServer::start();
        let store = MemoryStore::default();
        assert!(!oauth_status_of(&store, "srv", &server.url()).unwrap().signed_in);
        login(&server, &store, "srv");
        let status = oauth_status_of(&store, "srv", &server.url()).unwrap();
        assert!(status.signed_in);
        assert_eq!(status.scope.as_deref(), Some("files:read"));
        // access token หมดอายุแต่ยังต่ออายุได้ = ยังถือว่าล็อกอินอยู่
        let mut record = oauth_load(&store, "srv").unwrap().unwrap();
        record.expires_at = Some(now_secs() - 1);
        oauth_save(&store, "srv", &record).unwrap();
        assert!(oauth_status_of(&store, "srv", &server.url()).unwrap().signed_in);
    }

    #[test]
    fn server_names_are_validated_before_touching_the_vault() {
        let store = MemoryStore::default();
        assert!(oauth_load(&store, "../other").is_err());
        assert!(oauth_delete(&store, "a.b").is_err());
        assert!(oauth_bearer(&store, "", "https://example.com").is_err());
    }
}
