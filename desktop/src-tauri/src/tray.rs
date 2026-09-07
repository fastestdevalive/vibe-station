use std::fs;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime};

/// Build and register the system tray icon with its context menu.
pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, "open", "Open vibe-station", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit completely", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&open_item, &quit_item])?;

    let mut builder = TrayIconBuilder::new().menu(&menu);
    // Use the bundled window icon for the tray when available; skip it (tray
    // falls back to a system default) rather than panicking if none is set.
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "quit" => {
                // Read the daemon pid from config.json and SIGTERM it before exiting.
                terminate_daemon();
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

/// Read daemon pid from ~/.vibe-station/config.json and send SIGTERM.
fn terminate_daemon() {
    let Some(home) = dirs_next::home_dir() else {
        return;
    };
    let config_path = home.join(".vibe-station").join("config.json");
    let Ok(text) = fs::read_to_string(&config_path) else {
        return;
    };

    #[derive(serde::Deserialize)]
    struct Config {
        pid: u32,
    }

    if let Ok(cfg) = serde_json::from_str::<Config>(&text) {
        // Safety: SIGTERM is a standard termination signal.
        unsafe {
            libc::kill(cfg.pid as libc::pid_t, libc::SIGTERM);
        }
    }
}
