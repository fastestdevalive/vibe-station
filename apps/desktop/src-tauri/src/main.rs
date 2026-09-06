// Prevents a console window from appearing on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod daemon;
mod tray;

use std::path::PathBuf;

use tauri::{Manager, WindowEvent};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Resolve the bundled cloudflared binary path.
            // Tauri strips the target-triple suffix from externalBin entries at bundle
            // time, so the binary lands in the resource directory as plain "cloudflared".
            let cloudflared_bin: PathBuf = app_handle
                .path()
                .resource_dir()
                .ok()
                .map(|dir| {
                    // On Windows the binary has an .exe extension; the resource_dir()
                    // lookup covers both cases.
                    let name = if cfg!(target_os = "windows") {
                        "cloudflared.exe"
                    } else {
                        "cloudflared"
                    };
                    let p = dir.join(name);
                    if p.exists() { p } else { PathBuf::from("cloudflared") }
                })
                .unwrap_or_else(|| PathBuf::from("cloudflared"));

            // Detect an already-running daemon, or spawn one.
            let daemon_info = match daemon::detect_running_daemon() {
                Some(info) => {
                    println!("[vst] found running daemon on port {}", info.port);
                    info
                }
                None => {
                    println!("[vst] no running daemon — spawning sidecar...");
                    match daemon::spawn_daemon(&app_handle, &cloudflared_bin) {
                        Ok(info) => {
                            println!("[vst] daemon ready on port {}", info.port);
                            info
                        }
                        Err(e) => {
                            eprintln!("[vst] failed to start daemon: {e}");
                            // Still attempt to open the UI — user may resolve manually.
                            daemon::DaemonInfo {
                                port: 7422,
                                pid: 0,
                                token: String::new(),
                            }
                        }
                    }
                }
            };

            let port = daemon_info.port;
            let token = daemon_info.token.clone();

            // OS label injected into the document so CSS can target macOS traffic-light
            // clearance (body[data-tauri-os="macos"]) and WindowControls.tsx can detect Linux.
            let os_name = if cfg!(target_os = "macos") {
                "macos"
            } else if cfg!(target_os = "linux") {
                "linux"
            } else {
                "windows"
            };

            // Inject port, token, and OS tag before any page JS runs.
            // __VST_TOKEN__ lets useAuth auto-login without showing the login screen.
            // The IIFE handles the race: eval() may fire before or after DOMContentLoaded.
            let init_script = format!(
                "window.__VST_PORT__ = {port};\
                 window.__VST_TOKEN__ = '{token}';\
                 (function() {{\
                   function tag() {{ document.body && document.body.setAttribute('data-tauri-os', '{os_name}'); }}\
                   if (document.readyState === 'loading') {{\
                     document.addEventListener('DOMContentLoaded', tag);\
                   }} else {{\
                     tag();\
                   }}\
                 }})();"
            );

            // Get the window Tauri auto-created from tauri.conf.json and inject port/OS.
            // The SPA is a React app that never hard-navigates, so eval() is stable.
            let win = app
                .get_webview_window("main")
                .ok_or("main window not found")?;

            win.eval(&init_script)?;

            // Set up the system tray.
            tray::build_tray(&app_handle)?;

            Ok(())
        })
        .on_window_event(|win, event| {
            // Hide instead of close when the user clicks the ✕ button.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = win.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running vibe-station desktop");
}
