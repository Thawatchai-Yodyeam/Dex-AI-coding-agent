use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Default)]
pub struct AppState {
    pub running_processes: Arc<Mutex<HashMap<String, u32>>>,
    pub cancelled_ids: Arc<Mutex<HashSet<String>>>,
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
    let working_dir = match cwd {
        Some(ref dir) if !dir.trim().is_empty() => PathBuf::from(dir),
        _ => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    };

    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &command])
       .current_dir(&working_dir)
       .stdout(Stdio::piped())
       .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW ป้องกัน Console สีดำเด้ง

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
    let limit_secs = timeout_secs.unwrap_or(120);
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

// 6.1 แทนที่เนื้อหาเฉพาะจุดในไฟล์ (Surgical Edit)
#[tauri::command]
fn replace_file_content(
    path: String,
    target_content: String,
    replacement_content: String,
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

    let count = file_text.matches(&target_content).count();
    if count == 0 {
        // Fallback with CRLF/LF normalization
        let norm_file = file_text.replace("\r\n", "\n");
        let norm_target = target_content.replace("\r\n", "\n");
        let norm_count = norm_file.matches(&norm_target).count();
        if norm_count == 0 {
            return Err("ไม่พบ target_content ที่ระบุในไฟล์ กรุณาตรวจสอบข้อความที่ต้องการแก้ไข".to_string());
        }
        if norm_count > 1 {
            return Err(format!(
                "พบ target_content ซ้ำกัน {} จุดในไฟล์ กรุณาระบุบริบทโค้ดให้เฉพาะเจาะจงยิ่งขึ้น",
                norm_count
            ));
        }
        let norm_replacement = replacement_content.replace("\r\n", "\n");
        let mut new_text = norm_file.replacen(&norm_target, &norm_replacement, 1);
        // รักษา CRLF ตามเดิมหากไฟล์ต้นฉบับใช้ CRLF
        if file_text.contains("\r\n") {
            new_text = new_text.replace('\n', "\r\n");
        }
        write_atomic(&valid_path, new_text.as_bytes())
            .map_err(|e| format!("เขียนไฟล์ไม่สำเร็จ: {}", e))?;
        return Ok(ReplaceResult {
            success: true,
            message: format!("แทนที่เนื้อหาใน {} สำเร็จ (1 ตำแหน่ง)", valid_path.display()),
            occurrences: 1,
        });
    }

    if count > 1 {
        return Err(format!(
            "พบ target_content ซ้ำกัน {} จุดในไฟล์ กรุณาระบุบริบทโค้ดรอบข้างเพิ่มเติมเพื่อให้เป็นเอกลักษณ์",
            count
        ));
    }

    let new_text = file_text.replacen(&target_content, &replacement_content, 1);
    write_atomic(&valid_path, new_text.as_bytes())
        .map_err(|e| format!("เขียนไฟล์ไม่สำเร็จ: {}", e))?;

    Ok(ReplaceResult {
        success: true,
        message: format!("แทนที่เนื้อหาใน {} สำเร็จ", valid_path.display()),
        occurrences: 1,
    })
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

// 6.2 ค้นหาข้อความหรือโค้ดข้ามทั้งโปรเจกต์ (substring search)
// รันใน blocking thread pool เพื่อไม่ให้หน้าต่างค้างระหว่างสแกน
#[tauri::command]
async fn grep_search(
    query: String,
    case_insensitive: Option<bool>,
    max_results: Option<usize>,
    workspace: Option<String>,
) -> Result<Vec<GrepMatch>, String> {
    if query.is_empty() {
        return Err("query ต้องไม่เป็นค่าว่าง".to_string());
    }
    let root = resolve_workspace_root(workspace.as_deref());
    tokio::task::spawn_blocking(move || {
        let limit = max_results.unwrap_or(50).clamp(1, 500);
        let case_ins = case_insensitive.unwrap_or(true);
        let needle = if case_ins { query.to_lowercase() } else { query };
        let mut matches = Vec::new();

        walk_workspace(&root, |path, rel| {
            // ไม่ค้นในไฟล์ลับ — ไม่งั้นค้นคำว่า "KEY" ก็ได้ API key ออกไปทั้งบรรทัด
            if is_sensitive_path(Path::new(rel)) {
                return true;
            }
            let too_big = fs::metadata(path).map(|m| m.len() > MAX_SEARCH_FILE_BYTES).unwrap_or(true);
            if too_big {
                return true;
            }
            // read_to_string ล้มเหลวกับไฟล์ไบนารี/ไม่ใช่ UTF-8 → ข้าม
            if let Ok(content) = fs::read_to_string(path) {
                for (idx, line) in content.lines().enumerate() {
                    let hay = if case_ins { line.to_lowercase() } else { line.to_string() };
                    if hay.contains(&needle) {
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

// 6.3 ค้นหาไฟล์ตามชื่อหรือ Pattern (`*.ext` หรือ substring ของ path)
#[tauri::command]
async fn find_files(pattern: String, workspace: Option<String>) -> Result<Vec<String>, String> {
    let root = resolve_workspace_root(workspace.as_deref());
    tokio::task::spawn_blocking(move || {
        let pat = pattern.trim().to_lowercase().replace('\\', "/");
        let ext_filter = pat
            .strip_prefix('*')
            .map(|e| e.trim_start_matches('.').to_string())
            .filter(|e| !e.is_empty() && !e.contains('*') && !e.contains('/'));
        let needle = pat.replace('*', "");
        let mut results = Vec::new();

        walk_workspace(&root, |_, rel| {
            let rel_lower = rel.to_lowercase();
            let matched = match &ext_filter {
                Some(ext) => rel_lower.ends_with(&format!(".{}", ext)),
                None => needle.is_empty() || rel_lower.contains(&needle),
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            check_security,
            execute_command,
            kill_command,
            read_file,
            write_file,
            list_dir,
            get_initial_env,
            select_folder,
            replace_file_content,
            grep_search,
            find_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
}
