//! DB Desk Mobile — a thin client.
//!
//! The phone never talks to a database. It opens the DB Desk server you already
//! run (app.dbdesk.app, or your own), which holds the connections and enforces
//! read-only, approvals and the login. That is the only architecture that can
//! work: the desktop app leans on a Python sidecar, and iOS will not let an app
//! bundle an interpreter.
//!
//! The connect screen is the bundled UI. Once a server URL is chosen the webview
//! navigates to it and from then on the remote page is the app.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running DB Desk Mobile");
}
