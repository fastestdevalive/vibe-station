//! The web UI mirrors two Rust timing constants by hand (no codegen). Fail when
//! they drift: `RESTART_WAIT_MS` = `UI_CLI_RESTART_WAIT`, `FORCE_FLOOR_MS` =
//! `service::FORCE_FLOOR`. Skipped when the web sources are not alongside the crate.

use std::path::PathBuf;

fn ts_const_ms(file: &str, name: &str) -> Option<u64> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../web-ui/src/components")
        .join(file);
    let src = std::fs::read_to_string(path).ok()?;
    let rest = src.split(&format!("const {name} = ")).nth(1)?;
    let digits: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '_')
        .filter(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

#[test]
fn restart_wait_matches_the_overlay() {
    let Some(ms) = ts_const_ms("update/RestartOverlay.tsx", "RESTART_WAIT_MS") else {
        return;
    };
    assert_eq!(
        ms as u128,
        vst_daemon::update::UI_CLI_RESTART_WAIT.as_millis(),
        "RestartOverlay.tsx RESTART_WAIT_MS != update::timing::UI_CLI_RESTART_WAIT"
    );
}

#[test]
fn force_floor_matches_the_settings_panel() {
    let Some(ms) = ts_const_ms("settings/UpdateSetting.tsx", "FORCE_FLOOR_MS") else {
        return;
    };
    assert_eq!(
        ms as u128,
        vst_daemon::update::service::FORCE_FLOOR.as_millis(),
        "UpdateSetting.tsx FORCE_FLOOR_MS != update::service::FORCE_FLOOR"
    );
}
