use super::*;
use chrono::Duration as CDur;
use vst_types::rest::update::{InstallStage, StartedBy};

fn releases_json(tag: &str) -> String {
    format!(
        r#"[{{"tag_name":"{tag}","prerelease":false,"draft":false,"body":"notes","html_url":"https://example.test/r","assets":[{{"name":"vst-x86_64-unknown-linux-musl.tar.gz","browser_download_url":"https://example.test/a","size":10}}]}}]"#
    )
}

fn svc(dir: &Path, broadcaster: Option<Broadcaster>) -> Arc<UpdateService> {
    UpdateService::new(UpdateConfig {
        vst_home: dir.to_path_buf(),
        current_version: "0.1.0".to_string(),
        boot_exe: PathBuf::from("/nonexistent/vst"),
        boot_id: "b".to_string(),
        api_base: format!("{}/svc", mockito::server_url()),
        broadcaster,
        check_interval: Duration::from_secs(3 * 24 * 3600),
        first_check_delay: Duration::from_secs(60),
        force_floor: Duration::from_secs(30),
    })
}

static MOCK_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[test]
fn due_rule() {
    let now = Utc::now();
    let iv = Duration::from_secs(3 * 24 * 3600);
    let fmt = |t: DateTime<Utc>| t.to_rfc3339_opts(SecondsFormat::Secs, true);
    assert!(is_due(None, now, iv));
    assert!(!is_due(Some(&fmt(now - CDur::days(1))), now, iv));
    assert!(is_due(Some(&fmt(now - CDur::days(4))), now, iv));
    assert!(is_due(Some(&fmt(now + CDur::days(1))), now, iv));
    assert!(is_due(Some("garbage"), now, iv));
}

#[tokio::test]
async fn forced_check_twice_hits_http_once() {
    let _g = MOCK_LOCK.lock().await;
    let m = mockito::mock("GET", "/svc/releases?per_page=20")
        .with_status(200)
        .with_body(releases_json("v0.2.0"))
        .expect(1)
        .create();
    let tmp = tempfile::tempdir().unwrap();
    let s = svc(tmp.path(), None);
    let a = s.check(true).await;
    let b = s.check(true).await;
    assert!(a.update_available);
    assert_eq!(a.latest.as_deref(), Some("0.2.0"));
    assert_eq!(a.checked_at, b.checked_at);
    m.assert();
}

#[tokio::test]
async fn non_forced_check_skips_when_not_due() {
    let _g = MOCK_LOCK.lock().await;
    let m = mockito::mock("GET", "/svc/releases?per_page=20")
        .with_status(200)
        .with_body(releases_json("v0.2.0"))
        .expect(0)
        .create();
    let tmp = tempfile::tempdir().unwrap();
    let recent = (Utc::now() - CDur::days(1)).to_rfc3339_opts(SecondsFormat::Secs, true);
    std::fs::write(
        tmp.path().join("update-state.json"),
        format!(r#"{{"lastChecked":"{recent}"}}"#),
    )
    .unwrap();
    let s = svc(tmp.path(), None);
    let st = s.check(false).await;
    assert_eq!(st.checked_at.as_deref(), Some(recent.as_str()));
    m.assert();
}

#[tokio::test]
async fn available_event_fires_once_per_version() {
    let _g = MOCK_LOCK.lock().await;
    let _m = mockito::mock("GET", "/svc/releases?per_page=20")
        .with_status(200)
        .with_body(releases_json("v0.2.0"))
        .create();
    let tmp = tempfile::tempdir().unwrap();
    let b = Broadcaster::new(16);
    let mut rx = b.subscribe();
    // floor 0 so the second forced check really runs
    let s = UpdateService::new(UpdateConfig {
        force_floor: Duration::from_secs(0),
        ..cfg_of(tmp.path(), Some(b))
    });
    s.check(true).await;
    s.check(true).await;
    let mut kinds = vec![];
    while let Ok(ev) = rx.try_recv() {
        kinds.push(match ev {
            ServerEvent::UpdateAvailable { .. } => "available",
            ServerEvent::UpdateChanged { .. } => "changed",
            _ => "other",
        });
    }
    assert_eq!(kinds, vec!["available", "changed"]);
}

fn cfg_of(dir: &Path, b: Option<Broadcaster>) -> UpdateConfig {
    UpdateConfig {
        vst_home: dir.to_path_buf(),
        current_version: "0.1.0".to_string(),
        boot_exe: PathBuf::from("/nonexistent/vst"),
        boot_id: "b".to_string(),
        api_base: format!("{}/svc", mockito::server_url()),
        broadcaster: b,
        check_interval: Duration::from_secs(3 * 24 * 3600),
        first_check_delay: Duration::from_secs(60),
        force_floor: Duration::from_secs(30),
    }
}

#[tokio::test]
async fn offline_records_last_error_not_panic() {
    let tmp = tempfile::tempdir().unwrap();
    let s = UpdateService::new(UpdateConfig {
        api_base: "http://127.0.0.1:9".to_string(),
        ..cfg_of(tmp.path(), None)
    });
    let st = s.check(true).await;
    let e = st.last_error.expect("lastError set");
    assert_eq!(e.kind, UpdateErrorKind::Check);
    assert!(!st.update_available);
}

fn script(path: &Path, ver: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, format!("#!/bin/sh\necho {ver}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn write_pending(dir: &Path, version: &str, exe: &Path) {
    std::fs::write(
        dir.join("update-state.json"),
        format!(
            r#"{{"pendingRestart":{{"version":"{version}","exePath":"{}","kind":"daemon"}}}}"#,
            exe.display()
        ),
    )
    .unwrap();
}

#[tokio::test]
async fn pending_restart_cleared_on_construction_when_caught_up() {
    let tmp = tempfile::tempdir().unwrap();
    write_pending(tmp.path(), "9.9.9", Path::new("/nonexistent/vst"));
    let s = UpdateService::new(UpdateConfig {
        current_version: "9.9.9".to_string(),
        ..cfg_of(tmp.path(), None)
    });
    assert!(s.snapshot().restart_pending.is_none());
    let saved = std::fs::read_to_string(tmp.path().join("update-state.json")).unwrap();
    assert!(!saved.contains("pendingRestart"), "{saved}");
}

#[tokio::test]
async fn pending_restart_cleared_on_check_when_exe_reports_old_version() {
    let tmp = tempfile::tempdir().unwrap();
    let exe = tmp.path().join("vst");
    script(&exe, "1.0.0");
    write_pending(tmp.path(), "9.9.9", &exe);
    let s = UpdateService::new(UpdateConfig {
        current_version: "1.0.0".to_string(),
        api_base: "http://127.0.0.1:9".to_string(),
        ..cfg_of(tmp.path(), None)
    });
    assert!(s.snapshot().restart_pending.is_some());
    s.check(true).await;
    assert!(s.snapshot().restart_pending.is_none());
    let saved = std::fs::read_to_string(tmp.path().join("update-state.json")).unwrap();
    assert!(!saved.contains("pendingRestart"), "{saved}");
}

#[tokio::test]
async fn pending_restart_kept_when_exe_reports_pending_version() {
    let tmp = tempfile::tempdir().unwrap();
    let exe = tmp.path().join("vst");
    script(&exe, "9.9.9");
    write_pending(tmp.path(), "9.9.9", &exe);
    let s = UpdateService::new(UpdateConfig {
        current_version: "1.0.0".to_string(),
        api_base: "http://127.0.0.1:9".to_string(),
        ..cfg_of(tmp.path(), None)
    });
    s.check(true).await;
    let rp = s.snapshot().restart_pending.expect("kept");
    assert_eq!(rp.version, "9.9.9");
}

#[tokio::test]
async fn rolled_back_suppresses_same_version_and_cleared_by_newer() {
    let _g = MOCK_LOCK.lock().await;
    let tmp = tempfile::tempdir().unwrap();

    // Setup state file with rolledBack: 9.9.9
    let state_file_path = tmp.path().join("update-state.json");
    let (store, mut state) = StateStore::load_or_default(state_file_path);
    state.rolled_back = Some(crate::update::state::RolledBack {
        failed_version: "9.9.9".into(),
        at: Utc::now().to_rfc3339(),
    });
    store.save(&state).unwrap();

    let s = UpdateService::new(UpdateConfig {
        current_version: "1.0.0".to_string(),
        api_base: format!("{}/svc", mockito::server_url()),
        ..cfg_of(tmp.path(), None)
    });

    // Mock GitHub returning release 9.9.9
    let m1 = mockito::mock("GET", "/svc/releases?per_page=20")
        .with_status(200)
        .with_body(releases_json("v9.9.9"))
        .create();

    let snap = s.check(true).await;
    m1.assert();
    assert_eq!(snap.latest.as_deref(), Some("9.9.9"));
    assert!(
        !snap.update_available,
        "update_available must be false when latest version equals rolledBack failed_version"
    );
    assert!(snap.rolled_back.is_some());

    // Mock GitHub returning newer release 9.9.10
    let m2 = mockito::mock("GET", "/svc/releases?per_page=20")
        .with_status(200)
        .with_body(releases_json("v9.9.10"))
        .create();

    // Advance floor or sleep so force_floor doesn't cache
    *s.last_attempt.lock().unwrap() = None;
    let snap2 = s.check(true).await;
    m2.assert();
    assert_eq!(snap2.latest.as_deref(), Some("9.9.10"));
    assert!(
        snap2.update_available,
        "update_available must be true when release is newer than failed_version"
    );
    assert!(
        snap2.rolled_back.is_none(),
        "rolled_back must be cleared when a release newer than failed_version is seen"
    );
}

#[tokio::test]
async fn cloudflared_env_and_pinned_appimage_are_not_tauri_hosted() {
    let tmp = tempfile::tempdir().unwrap();
    let s = UpdateService::with_env_for_tests(cfg_of(tmp.path(), None), |k| {
        (k == "VST_CLOUDFLARED_BIN").then(|| "/x".to_string())
    });
    s.set_detected_for_tests(InstallMethod::CurlAppImage, vec![]);
    assert!(!s.is_hosted_by_tauri());
}

#[tokio::test]
async fn hosted_by_env_marks_tauri_hosted() {
    let tmp = tempfile::tempdir().unwrap();
    let s = UpdateService::with_env_for_tests(cfg_of(tmp.path(), None), |k| {
        (k == "VST_HOSTED_BY").then(|| "tauri".to_string())
    });
    assert!(s.is_hosted_by_tauri());
}

/// A state file with a newer release already seen, so `start_install` clears
/// `install_ctx` and only the restart/install exclusion can reject it.
fn seed_latest(dir: &Path) {
    std::fs::write(
        dir.join("update-state.json"),
        r#"{"latestSeen":{"version":"9.9.9","tag":"v9.9.9","htmlUrl":"https://example.test/r","behindCount":1,"assets":[]}}"#,
    )
    .unwrap();
}

#[tokio::test]
async fn install_is_refused_once_restart_began_d05() {
    let tmp = tempfile::tempdir().unwrap();
    seed_latest(tmp.path());
    let s = UpdateService::new(cfg_of(tmp.path(), None));
    assert!(s.begin_restart().is_ok());
    let err = s.start_install(StartedBy::Ui).unwrap_err();
    assert_eq!(err.reason, UpdateReason::UpdateInProgress);
    assert!(s.rt.lock().unwrap().install.is_none());
}

#[tokio::test]
async fn restart_is_refused_while_install_runs_d05() {
    let tmp = tempfile::tempdir().unwrap();
    let s = UpdateService::new(cfg_of(tmp.path(), None));
    s.rt.lock().unwrap().install = Some(InstallProgress {
        stage: InstallStage::Downloading,
        pct: 10,
        started_by: StartedBy::Ui,
    });
    assert_eq!(s.begin_restart(), Err(UpdateApiErrorCode::UpdateInProgress));
    assert!(!s.is_restarting());
    s.rt.lock().unwrap().install = None;
    assert!(s.begin_restart().is_ok());
    assert_eq!(
        s.begin_restart(),
        Err(UpdateApiErrorCode::RestartInProgress)
    );
}

async fn assert_unforced_check_never_fetches(state_json: &str, env_off: bool) {
    let _g = MOCK_LOCK.lock().await;
    let m = mockito::mock("GET", "/svc/releases?per_page=20")
        .with_status(200)
        .with_body(releases_json("v0.2.0"))
        .expect(0)
        .create();
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("update-state.json"), state_json).unwrap();
    let s = UpdateService::with_env_for_tests(cfg_of(tmp.path(), None), move |k| {
        (env_off && k == "VST_UPDATE_CHECK").then(|| "0".to_string())
    });
    let st = s.check(false).await;
    assert!(st.checked_at.is_none());
    assert!(!st.update_available);
    m.assert();
}

#[tokio::test]
async fn non_forced_check_ignores_due_when_env_disables_d08() {
    assert_unforced_check_never_fetches("{}", true).await;
}

#[tokio::test]
async fn non_forced_check_ignores_due_when_auto_check_off_d08() {
    assert_unforced_check_never_fetches(r#"{"autoCheck":false}"#, false).await;
}

#[tokio::test]
async fn non_forced_check_never_fetches_even_when_due_d08() {
    // Page loads are cached-only; the 60 s boot delay is only honoured
    // by `run_background`, so an unforced call must not fetch at all.
    assert_unforced_check_never_fetches("{}", false).await;
}
