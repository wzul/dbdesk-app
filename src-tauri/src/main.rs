#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct Server(Mutex<Option<Child>>);

/// Escape a value for an AppleScript double-quoted string.
fn applescript_quote(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\r', " ")
        .replace('\n', " ")
}

/// Deliver a notification through `osascript`.
///
/// macOS rejects `UNUserNotificationCenter` authorization for ad-hoc signed
/// apps (no Developer ID), and the Tauri plugin reports success even when the
/// delivery is dropped. AppleScript posts through System Events and still works
/// for ad-hoc builds; the banner is attributed to Script Editor.
#[tauri::command]
fn native_notify(title: String, body: String) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "display notification \"{}\" with title \"{}\"",
            applescript_quote(&body),
            applescript_quote(&title)
        );
        let output = Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|err| format!("osascript could not run: {err}"))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if detail.is_empty() {
                "osascript failed".to_string()
            } else {
                detail
            });
        }
        Ok("osascript".to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (title, body);
        Err("native_notify is macOS-only".to_string())
    }
}


/// Best-effort notification diagnostics for the Settings panel.
#[tauri::command]
fn notification_diagnostics() -> serde_json::Value {
    let exe = std::env::current_exe().ok();
    let app = exe.as_ref().and_then(|path| {
        path.ancestors()
            .find(|item| item.extension().map(|ext| ext == "app").unwrap_or(false))
            .map(|item| item.to_path_buf())
    });
    let path = app
        .as_ref()
        .map(|item| item.display().to_string())
        .unwrap_or_default();
    let translocated = path.contains("/AppTranslocation/");
    let in_applications = path.starts_with("/Applications");

    let mut signature_ok = false;
    let mut signature_error = String::new();
    let mut signature = "unknown".to_string();
    let mut hardened = false;
    #[cfg(target_os = "macos")]
    {
      if let Some(bundle) = &app {
        if let Ok(output) = Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(bundle)
            .output()
        {
            signature_ok = output.status.success();
            signature_error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        }
        if let Ok(output) = Command::new("/usr/bin/codesign")
            .args(["-dv", "--verbose=2"])
            .arg(bundle)
            .output()
        {
            let text = String::from_utf8_lossy(&output.stderr).to_string();
            hardened = text.contains("runtime");
            if text.contains("Signature=adhoc") {
                signature = "ad-hoc".to_string();
            } else if let Some(line) = text.lines().find(|line| line.starts_with("Authority=")) {
                signature = line.trim_start_matches("Authority=").to_string();
            }
        }
      }
    }

    let mut registered = "unknown".to_string();
    #[cfg(target_os = "macos")]
    {
      if let Ok(home) = std::env::var("HOME") {
        let prefs = format!("{home}/Library/Preferences/com.apple.ncprefs.plist");
        if Path::new(&prefs).exists() {
            if let Ok(output) = Command::new("/usr/bin/plutil")
                .args(["-p", &prefs])
                .output()
            {
                let text = String::from_utf8_lossy(&output.stdout).to_string();
                if !text.is_empty() {
                    registered = if text.contains("com.wzul.dbdesk") {
                        "found".to_string()
                    } else {
                        "missing".to_string()
                    };
                }
            }
        }
      }
    }

    serde_json::json!({
        "path": path,
        "in_applications": in_applications,
        "translocated": translocated,
        "signature": signature,
        "signature_ok": signature_ok,
        "signature_error": signature_error,
        "hardened_runtime": hardened,
        "registered": registered,
    })
}

/// Open System Settings → Notifications (best effort).
#[tauri::command]
fn open_notification_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
            .status()
            .map_err(|err| format!("could not open System Settings: {err}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("only available on macOS".to_string())
    }
}

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "dbdesk-server.exe"
    } else {
        "dbdesk-server"
    }
}

fn user_home() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
}

/// Same default as `backend/app.py` so both launch paths share one data dir.
fn default_home() -> PathBuf {
    if cfg!(target_os = "macos") {
        user_home().join("Library/Application Support/DB Desk")
    } else if cfg!(windows) {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| user_home())
            .join("DB Desk")
    } else {
        std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| user_home().join(".local/share"))
            .join("dbdesk")
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .unwrap_or(8765)
}

/// Walk up from `start` looking for `backend/app.py` (development checkouts).
fn find_dev_server(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    for _ in 0..8 {
        let dir = current?;
        let candidate = dir.join("backend").join("app.py");
        if candidate.is_file() {
            return Some(candidate);
        }
        current = dir.parent();
    }
    None
}

#[cfg(unix)]
fn ensure_exec(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    if let Ok(metadata) = std::fs::metadata(path) {
        let mut permissions = metadata.permissions();
        let mode = permissions.mode();
        if mode & 0o111 == 0 {
            permissions.set_mode(mode | 0o755);
            let _ = std::fs::set_permissions(path, permissions);
        }
    }
}

#[cfg(not(unix))]
fn ensure_exec(_path: &Path) {}

fn sidecar_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(
            dir.join("sidecar")
                .join("dbdesk-server")
                .join(binary_name()),
        );
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(
                dir.join("sidecar")
                    .join("dbdesk-server")
                    .join(binary_name()),
            );
            candidates.push(dir.join(binary_name()));
        }
    }
    candidates
}

fn spawn_server(app: &AppHandle, port: u16, home: &Path) -> Child {
    if let Ok(explicit) = std::env::var("DBDESK_SERVER") {
        let path = PathBuf::from(explicit);
        ensure_exec(&path);
        return Command::new(&path)
            .env("PORT", port.to_string())
            .env("HOST", "127.0.0.1")
            .env("DBDESK_HOME", home)
            .spawn()
            .unwrap_or_else(|error| panic!("could not start {}: {error}", path.display()));
    }

    for candidate in sidecar_candidates(app) {
        if candidate.is_file() {
            ensure_exec(&candidate);
            return Command::new(&candidate)
                .env("PORT", port.to_string())
                .env("HOST", "127.0.0.1")
                .env("DBDESK_HOME", home)
                .spawn()
                .unwrap_or_else(|error| {
                    panic!("could not start {}: {error}", candidate.display())
                });
        }
    }

    let exe = std::env::current_exe().unwrap_or_default();
    let exe_dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    let app_py = std::env::var("DBDESK_APP")
        .ok()
        .map(PathBuf::from)
        .or_else(|| find_dev_server(&exe_dir))
        .or_else(|| find_dev_server(&std::env::current_dir().unwrap_or_default()))
        .expect("bundled sidecar missing and backend/app.py not found (set DBDESK_APP)");
    let python = std::env::var("DBDESK_PYTHON").unwrap_or_else(|_| "python3".to_string());
    Command::new(&python)
        .arg(&app_py)
        .env("PORT", port.to_string())
        .env("HOST", "127.0.0.1")
        .env("DBDESK_HOME", home)
        .spawn()
        .unwrap_or_else(|error| panic!("could not run {python} {}: {error}", app_py.display()))
}

fn wait_for_port(port: u16, attempts: u32) -> bool {
    for _ in 0..attempts {
        match TcpStream::connect(("127.0.0.1", port)) {
            Ok(_) => return true,
            Err(_) => thread::sleep(Duration::from_millis(100)),
        }
    }
    false
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            native_notify,
            notification_diagnostics,
            open_notification_settings
        ])
        .setup(|app| {
            let home = std::env::var("DBDESK_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| default_home());
            std::fs::create_dir_all(&home).ok();
            app.manage(Server(Mutex::new(None)));

            // Show the splash immediately, then start the sidecar off-thread and
            // navigate the same window once it accepts connections.
            let _window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("splash.html".into()),
            )
            .title("DB Desk")
            .inner_size(1280.0, 820.0)
            .min_inner_size(900.0, 600.0)
            .build()?;

            let handle = app.handle().clone();
            let home = home.clone();
            let port = free_port();
            thread::spawn(move || {
                let child = spawn_server(&handle, port, &home);
                if let Some(state) = handle.try_state::<Server>() {
                    if let Ok(mut guard) = state.0.lock() {
                        *guard = Some(child);
                    }
                }
                let ready = wait_for_port(port, 150);
                if let Some(window) = handle.get_webview_window("main") {
                    if ready {
                        let url = format!("http://127.0.0.1:{port}");
                        if let Ok(parsed) = url.parse() {
                            let _ = window.navigate(parsed);
                        }
                    } else {
                        let _ = window.eval(
                            "document.querySelector('.hint').textContent = \
                             'Could not start the local engine. Check Console and retry.';",
                        );
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building DB Desk")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Server>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        });
}
