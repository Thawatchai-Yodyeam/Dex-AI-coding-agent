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
}

const MAX_SKILL_FILE_BYTES: u64 = 256 * 1024;

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
            });
        }
    }
    skills
}

#[tauri::command]
fn list_skills(workspace: Option<String>) -> Vec<SkillInfo> {
    scan_skills(&skill_roots(workspace.as_deref()))
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

/// แทน `${NAME}` ด้วยค่า environment variable — ให้เก็บ token ไว้ใน env แทนการพิมพ์ลง settings
fn expand_env(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        match rest[start + 2..].find('}') {
            Some(end) => {
                let name = &rest[start + 2..start + 2 + end];
                out.push_str(&std::env::var(name).unwrap_or_default());
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
}

/// POST หนึ่งครั้งสำหรับ MCP แบบ Streamable HTTP — คืน response ทุกสถานะ (ให้ฝั่ง TS ตัดสินเอง)
#[tauri::command]
async fn mcp_http_request(
    url: String,
    headers: HashMap<String, String>,
    body: String,
    timeout_ms: Option<u64>,
) -> Result<HttpResponse, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("MCP URL ต้องขึ้นต้นด้วย http:// หรือ https://".to_string());
    }
    tokio::task::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_millis(timeout_ms.unwrap_or(120_000).clamp(1_000, 900_000)))
            .build();
        let mut req = agent.post(&expand_env(&url));
        for (k, v) in &headers {
            req = req.set(k, &expand_env(v));
        }
        let resp = match req.send_string(&body) {
            Ok(r) => r,
            Err(ureq::Error::Status(_, r)) => r,
            Err(e) => return Err(format!("เชื่อมต่อ MCP server ไม่สำเร็จ: {}", e)),
        };
        let status = resp.status();
        let mut out_headers = HashMap::new();
        for name in resp.headers_names() {
            if let Some(v) = resp.header(&name) {
                out_headers.insert(name.to_lowercase(), v.to_string());
            }
        }
        let body = resp.into_string().map_err(|e| format!("อ่าน response ไม่สำเร็จ: {}", e))?;
        Ok(HttpResponse { status, headers: out_headers, body })
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
const BROWSER_LABEL: &str = "dex-browser";

/// method ของ DevTools protocol ที่ UI เรียกได้ — ไม่เปิดทั้งหมด (Network/Storage/Target ฯลฯ)
const BROWSER_CDP_METHODS: &[&str] = &[
    "Runtime.evaluate",
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
            list_dir,
            get_initial_env,
            load_api_keys,
            save_api_key,
            list_skills,
            read_skill_file,
            mcp_start,
            mcp_send,
            mcp_stop,
            mcp_http_request,
            web_fetch,
            browser_open,
            browser_set_bounds,
            browser_set_visible,
            browser_url,
            browser_navigate,
            browser_cdp,
            save_session_history,
            load_session_history,
            delete_session_history,
            save_chat_session,
            load_chat_sessions,
            delete_chat_session,
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
