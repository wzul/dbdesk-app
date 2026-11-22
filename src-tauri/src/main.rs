#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct Server(Mutex<Option<Child>>);

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

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "dbdesk-server.exe"
    } else {
        "dbdesk-server"
    }
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

fn spawn_server(port: u16, home: &Path) -> Child {
    let exe = std::env::current_exe().expect("current executable path");
    let exe_dir = exe.parent().expect("executable directory").to_path_buf();

    let candidates = [
        std::env::var("DBDESK_SERVER").ok().map(PathBuf::from),
        Some(exe_dir.join(binary_name())),
    ];
    for candidate in candidates.into_iter().flatten() {
        if candidate.is_file() {
            return Command::new(&candidate)
                .env("PORT", port.to_string())
                .env("HOST", "127.0.0.1")
                .env("DBDESK_HOME", home)
                .spawn()
                .unwrap_or_else(|error| panic!("could not start {}: {error}", candidate.display()));
        }
    }

    let app_py = std::env::var("DBDESK_APP")
        .ok()
        .map(PathBuf::from)
        .or_else(|| find_dev_server(&exe_dir))
        .or_else(|| find_dev_server(&std::env::current_dir().unwrap_or_default()))
        .expect("bundled dbdesk-server missing and backend/app.py not found (set DBDESK_APP)");
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
            Err(error) if error.kind() == ErrorKind::ConnectionRefused => {
                thread::sleep(Duration::from_millis(150));
            }
            Err(_) => thread::sleep(Duration::from_millis(150)),
        }
    }
    false
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let home = std::env::var("DBDESK_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| default_home());
            std::fs::create_dir_all(&home).ok();

            let port = free_port();
            let child = spawn_server(port, &home);
            app.manage(Server(Mutex::new(Some(child))));

            wait_for_port(port, 100);

            let url = format!("http://127.0.0.1:{port}");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("DB Desk")
                .inner_size(1280.0, 820.0)
                .min_inner_size(900.0, 600.0)
                .build()?;
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
