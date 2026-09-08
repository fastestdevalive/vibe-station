// Prevents a console window from appearing on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod daemon;
mod tray;

use std::path::PathBuf;

use tauri::{Manager, WebviewWindowBuilder, WindowEvent};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            let cloudflared_bin: PathBuf = app_handle
                .path()
                .resource_dir()
                .ok()
                .map(|dir| {
                    let name = if cfg!(target_os = "windows") {
                        "cloudflared.exe"
                    } else {
                        "cloudflared"
                    };
                    let p = dir.join(name);
                    if p.exists() { p } else { PathBuf::from("cloudflared") }
                })
                .unwrap_or_else(|| PathBuf::from("cloudflared"));

            let vst_bin: PathBuf = app_handle
                .path()
                .resource_dir()
                .ok()
                .map(|dir| {
                    let name = if cfg!(target_os = "windows") { "vst.exe" } else { "vst" };
                    let p = dir.join(name);
                    if p.exists() { p } else { PathBuf::from("vst") }
                })
                .unwrap_or_else(|| PathBuf::from("vst"));

            let skill_path: PathBuf = app_handle
                .path()
                .resource_dir()
                .ok()
                .map(|dir| {
                    let p = dir.join("SKILL.md");
                    if p.exists() { p } else { PathBuf::from("SKILL.md") }
                })
                .unwrap_or_else(|| PathBuf::from("SKILL.md"));

            let daemon_info = match daemon::detect_running_daemon() {
                Some(info) => {
                    println!("[vst] found running daemon on port {}", info.port);
                    info
                }
                None => {
                    println!("[vst] no running daemon — spawning sidecar...");
                    match daemon::spawn_daemon(&app_handle, &cloudflared_bin, &vst_bin, &skill_path) {
                        Ok(info) => {
                            println!("[vst] daemon ready on port {}", info.port);
                            info
                        }
                        Err(e) => {
                            #[cfg(debug_assertions)]
                            panic!("[vst] daemon not found — is beforeDevCommand running? error: {e}");
                            #[cfg(not(debug_assertions))]
                            {
                                eprintln!("[vst] failed to start daemon: {e}");
                                daemon::DaemonInfo {
                                    port: 7422,
                                    pid: 0,
                                    token: String::new(),
                                }
                            }
                        }
                    }
                }
            };

            // Store daemon info in app state for future invoke commands.
            app.manage(daemon_info.clone());

            let os_name = if cfg!(target_os = "macos") {
                "macos"
            } else if cfg!(target_os = "linux") {
                "linux"
            } else {
                "windows"
            };

            // Build the "main" window from its config entry and attach the
            // initialization script. The script runs after the JS global object
            // is created but before any page script — the only race-free way to
            // guarantee __VST_TOKEN__ is present when useAuth reads it.
            // "create": false in tauri.conf.json prevents the auto-creation that
            // would otherwise happen before setup() runs.
            let script = build_init_script(daemon_info.port, &daemon_info.token, os_name);
            let conf = app.config().app.windows.first().cloned()
                .ok_or("no window config found")?;
            WebviewWindowBuilder::from_config(app.handle(), &conf)?
                .initialization_script(&script)
                .build()?;

            tray::build_tray(&app_handle)?;

            Ok(())
        })
        .on_window_event(|win, event| {
            // Hide instead of close when the user clicks the ✕ button —
            // but only for the main window; secondary windows should close normally.
            if win.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = win.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running vibe-station desktop");
}

/// Returns the JS initialization script injected into every new window.
///
/// Uses serde_json::to_string for safe token quoting (handles any chars the
/// token might contain). The IIFE sets data-tauri-os after DOMContentLoaded
/// because the init script runs before document.body exists.
///
/// NOTE: __VST_PORT__ is read by baseUrl() in web-ui/src/api/client.ts to
/// build an absolute daemon URL when running inside the Tauri shell.
fn build_init_script(port: u16, token: &str, os_name: &str) -> String {
    let token_json = serde_json::to_string(token).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "window.__VST_PORT__ = {port};\
         window.__VST_TOKEN__ = {token_json};\
         (function() {{\
           function tag() {{ document.body && document.body.setAttribute('data-tauri-os', '{os_name}'); }}\
           if (document.readyState === 'loading') {{\
             document.addEventListener('DOMContentLoaded', tag);\
           }} else {{\
             tag();\
           }}\
         }})();"
    )
}
