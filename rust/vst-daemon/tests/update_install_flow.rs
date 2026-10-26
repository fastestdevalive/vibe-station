//! Integration: `run_install` end to end against a mock release host.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use vst_daemon::update::install::cancel::CancelToken;
use vst_daemon::update::install::signature::test_support::{
    keypair_from_seed, manifest_bytes, sign_minisig,
};
use vst_daemon::update::install::{run_install, InstallCtx};
use vst_daemon::update::platform::{assets_for, platform_key};
use vst_daemon::update::state::{AssetRef, RestartKind};
use vst_types::rest::update::{InstallMethod, InstallStage, UpdateTarget};

// mockito 0.31 is process-global; the tests in this file share one lock.
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn script(path: &Path, ver: &str) {
    std::fs::write(path, format!("#!/bin/sh\necho {ver}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn tarball(dir: &Path, vst_ver: &str) -> Vec<u8> {
    let (src, out) = (dir.join("src"), dir.join("a.tar.gz"));
    std::fs::create_dir_all(&src).unwrap();
    script(&src.join("vst"), vst_ver);
    script(&src.join("claude-acp"), "adapter");
    let gz = flate2::write::GzEncoder::new(
        std::fs::File::create(&out).unwrap(),
        flate2::Compression::fast(),
    );
    let mut b = tar::Builder::new(gz);
    for n in ["vst", "claude-acp"] {
        b.append_path_with_name(src.join(n), n).unwrap();
    }
    b.into_inner().unwrap().finish().unwrap();
    std::fs::read(out).unwrap()
}

struct Fixture {
    _t: tempfile::TempDir,
    bin: PathBuf,
    ctx: InstallCtx,
    _mocks: Vec<mockito::Mock>,
}

const KID: [u8; 8] = [1, 2, 3, 4, 5, 6, 7, 8];

fn fixture(boot_in_target: bool) -> Option<Fixture> {
    fixture_with(boot_in_target, false)
}

/// `tamper_sig` serves a signature that does not match the manifest.
fn fixture_with(boot_in_target: bool, tamper_sig: bool) -> Option<Fixture> {
    fixture_full(boot_in_target, tamper_sig, None)
}

const DEB_NAME: &str = "vibe-station_9.9.9_amd64.deb";
const DEB_BODY: &[u8] = b"debbytes";

/// `deb` = `Some(status)`: also offer a signed `.deb` asset (the manifest
/// lists it) whose download answers with that HTTP status.
fn fixture_full(boot_in_target: bool, tamper_sig: bool, deb: Option<usize>) -> Option<Fixture> {
    fixture_ver(boot_in_target, tamper_sig, deb, "9.9.9")
}

/// `vst_ver` is what the archive's `vst --version` prints (the manifest and
/// `ctx.latest` stay 9.9.9, so anything else forces a smoke mismatch).
fn fixture_ver(
    boot_in_target: bool,
    tamper_sig: bool,
    deb: Option<usize>,
    vst_ver: &str,
) -> Option<Fixture> {
    let name = assets_for(platform_key()).cli?;
    let t = tempfile::tempdir().unwrap();
    let bin = t.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    script(&bin.join("vst"), "1.0.0");
    let body = tarball(t.path(), vst_ver);
    let m1 = mockito::mock("GET", format!("/itest/{name}").as_str())
        .with_body(&body)
        .create();
    let (_, kp) = keypair_from_seed([7u8; 32], KID);
    let mut entries: Vec<(&str, &[u8])> = vec![(name, &body)];
    if deb.is_some() {
        entries.push((DEB_NAME, DEB_BODY));
    }
    let man = manifest_bytes("v9.9.9", &entries);
    let mut sig = sign_minisig(&kp, KID, &man, "vibe-station v9.9.9");
    if tamper_sig {
        let other = manifest_bytes("v9.9.9", &[(name, b"other")]);
        sig = sign_minisig(&kp, KID, &other, "vibe-station v9.9.9");
    }
    let m2 = mockito::mock("GET", "/itest/SHA256SUMS")
        .with_body(man)
        .create();
    let m3 = mockito::mock("GET", "/itest/SHA256SUMS.minisig")
        .with_body(sig)
        .create();
    let base = mockito::server_url();
    let mut deb_mocks = Vec::new();
    if let Some(status) = deb {
        let m = mockito::mock("GET", format!("/itest/{DEB_NAME}").as_str())
            .with_status(status)
            .with_body(DEB_BODY)
            .create();
        deb_mocks.push(m);
    }
    let elsewhere = t.path().join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    let boot = if boot_in_target {
        bin.join("vst")
    } else {
        elsewhere.join("vst")
    };
    let ctx = InstallCtx {
        vst_home: t.path().join("home"),
        latest: "9.9.9".into(),
        current: "0.0.1".into(),
        trusted_keys: vec![keypair_from_seed([7u8; 32], KID).0],
        assets: vec![
            AssetRef {
                name: name.into(),
                url: format!("{base}/itest/{name}"),
                size: body.len() as u64,
            },
            AssetRef {
                name: "SHA256SUMS".into(),
                url: format!("{base}/itest/SHA256SUMS"),
                size: 300,
            },
            AssetRef {
                name: "SHA256SUMS.minisig".into(),
                url: format!("{base}/itest/SHA256SUMS.minisig"),
                size: 200,
            },
        ],
        targets: vec![
            UpdateTarget {
                method: InstallMethod::Curl,
                path: bin.join("vst").to_string_lossy().into_owned(),
                version: Some("1.0.0".into()),
                auto: true,
            },
            UpdateTarget {
                method: InstallMethod::Deb,
                path: "/usr/bin/vibe-station".into(),
                version: None,
                auto: false,
            },
        ],
        boot_exe: boot,
        appimage_env: None,
        keep_prev: false,
    };
    let mut ctx = ctx;
    if deb.is_some() {
        ctx.assets.push(AssetRef {
            name: DEB_NAME.into(),
            url: format!("{base}/itest/{DEB_NAME}"),
            size: DEB_BODY.len() as u64,
        });
    }
    let mut mocks = vec![m1, m2, m3];
    mocks.extend(deb_mocks);
    Some(Fixture {
        _t: t,
        bin,
        ctx,
        _mocks: mocks,
    })
}

async fn run(
    f: &Fixture,
) -> (
    vst_daemon::update::install::InstallOutcome,
    Vec<InstallStage>,
) {
    let seen = Mutex::new(Vec::<InstallStage>::new());
    let cb = |s: InstallStage, _p: u8| {
        let mut v = seen.lock().unwrap();
        if v.last() != Some(&s) {
            v.push(s);
        }
    };
    let out = run_install(f.ctx.clone(), &cb, Arc::new(CancelToken::new()))
        .await
        .unwrap();
    let stages = seen.into_inner().unwrap();
    (out, stages)
}

#[tokio::test]
async fn installs_in_stage_order_and_flags_restart_when_boot_exe_replaced() {
    let _g = LOCK.lock().await;
    let Some(f) = fixture(true) else { return };
    let (out, stages) = run(&f).await;
    assert_eq!(
        stages,
        [
            InstallStage::Preflight,
            InstallStage::Downloading,
            InstallStage::Verifying,
            InstallStage::Installing
        ]
    );
    let v = std::process::Command::new(f.bin.join("vst"))
        .arg("--version")
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&v.stdout).trim(), "9.9.9");
    assert!(f.bin.join("claude-acp").exists());
    assert!(f.bin.join(".vst.prev").exists());
    assert_eq!(out.result.version, "9.9.9");
    assert_eq!(
        out.result.updated,
        [f.bin.join("vst").to_string_lossy().into_owned()]
    );
    assert_eq!(out.result.manual.len(), 1);
    let p = out.pending_restart.expect("boot exe is in the target dir");
    assert_eq!(p.kind, RestartKind::Daemon);
    assert_eq!(p.version, "9.9.9");
    assert!(
        !f.ctx.vst_home.join("update-tmp").exists(),
        "scratch dir is cleaned"
    );
}

/// The smoke test runs while the stage is still `Verifying`, before
/// `Installing` is ever reported, and nothing live is touched.
#[tokio::test]
async fn smoke_mismatch_fails_in_verifying_stage_d19() {
    let _g = LOCK.lock().await;
    let Some(f) = fixture_ver(true, false, None, "9.9.8") else {
        return;
    };
    let seen = Mutex::new(Vec::<InstallStage>::new());
    let cb = |s: InstallStage, _p: u8| {
        let mut v = seen.lock().unwrap();
        if v.last() != Some(&s) {
            v.push(s);
        }
    };
    let err = run_install(f.ctx.clone(), &cb, Arc::new(CancelToken::new()))
        .await
        .unwrap_err();
    assert_eq!(
        err.reason,
        vst_types::rest::update::UpdateReason::SmokeFailed
    );
    let stages = seen.into_inner().unwrap();
    assert_eq!(stages.last(), Some(&InstallStage::Verifying), "{stages:?}");
    assert!(!stages.contains(&InstallStage::Installing));
    let v = std::process::Command::new(f.bin.join("vst"))
        .arg("--version")
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&v.stdout).trim(), "1.0.0");
    assert!(!f.bin.join(".vst.new").exists());
}

#[tokio::test]
async fn no_pending_restart_when_boot_exe_is_elsewhere() {
    let _g = LOCK.lock().await;
    let Some(f) = fixture(false) else { return };
    let (out, _) = run(&f).await;
    assert!(out.pending_restart.is_none());
}

#[tokio::test]
async fn curl_and_dmg_coexist_replaces_cli_and_flags_app_restart_if_in_bundle() {
    let _g = LOCK.lock().await;
    let Some(mut f) = fixture(true) else { return };

    f.ctx.targets.push(UpdateTarget {
        method: InstallMethod::Dmg,
        path: "/Applications/vibe-station.app".into(),
        version: Some("1.0.0".into()),
        auto: false,
    });
    f.ctx.assets.push(AssetRef {
        name: "vibe-station-aarch64-apple-darwin.dmg".into(),
        url: "https://example.com/download/dmg".into(),
        size: 50_000_000,
    });

    let (out1, _) = run(&f).await;
    assert_eq!(out1.result.updated.len(), 1);
    assert!(out1.result.manual.iter().any(|m| m
        .text
        .contains("Download vibe-station-aarch64-apple-darwin.dmg")));
    assert_eq!(
        out1.pending_restart.as_ref().unwrap().kind,
        RestartKind::Daemon
    );

    // Now test boot_exe inside .app bundle
    let Some(mut f2) = fixture(true) else { return };
    let app_bin = f2._t.path().join("vibe-station.app/Contents/MacOS");
    std::fs::create_dir_all(&app_bin).unwrap();
    script(&app_bin.join("vst"), "1.0.0");
    f2.ctx.targets = vec![
        UpdateTarget {
            method: InstallMethod::Curl,
            path: app_bin.join("vst").to_string_lossy().into_owned(),
            version: Some("1.0.0".into()),
            auto: true,
        },
        UpdateTarget {
            method: InstallMethod::Dmg,
            path: "/Applications/vibe-station.app".into(),
            version: Some("1.0.0".into()),
            auto: false,
        },
    ];
    f2.ctx.boot_exe = app_bin.join("vst");
    f2.ctx.assets.push(AssetRef {
        name: "vibe-station-aarch64-apple-darwin.dmg".into(),
        url: "https://example.com/download/dmg".into(),
        size: 50_000_000,
    });

    let (out2, _) = run(&f2).await;
    assert_eq!(out2.result.updated.len(), 1);
    assert_eq!(
        out2.pending_restart.as_ref().unwrap().kind,
        RestartKind::App
    );
}

fn version_of(p: &Path) -> String {
    let out = std::process::Command::new(p)
        .arg("--version")
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[tokio::test]
async fn second_install_before_restart_keeps_running_builds_prev_d10() {
    let _g = LOCK.lock().await;
    let Some(mut f) = fixture(true) else { return };
    run(&f).await;
    assert_eq!(version_of(&f.bin.join(".vst.prev")), "1.0.0");
    // Restart still pending: the on-disk 9.9.9 never booted, so .prev must
    // keep pointing at the build that is actually running.
    f.ctx.keep_prev = true;
    run(&f).await;
    assert_eq!(version_of(&f.bin.join(".vst.prev")), "1.0.0");
    // Control: without a pending restart the prior set is replaced.
    f.ctx.keep_prev = false;
    run(&f).await;
    assert_eq!(version_of(&f.bin.join(".vst.prev")), "9.9.9");
}

/// Point `$HOME` at a scratch dir so `deb_download` can't touch the real
/// `~/Downloads`; restored on drop. Callers hold `LOCK`.
struct HomeGuard(Option<std::ffi::OsString>);
impl HomeGuard {
    fn set(to: &Path) -> Self {
        let old = std::env::var_os("HOME");
        std::env::set_var("HOME", to);
        HomeGuard(old)
    }
}
impl Drop for HomeGuard {
    fn drop(&mut self) {
        match self.0.take() {
            Some(h) => std::env::set_var("HOME", h),
            None => std::env::remove_var("HOME"),
        }
    }
}

#[tokio::test]
async fn failed_deb_download_fails_before_any_cli_file_changes_d09() {
    let _g = LOCK.lock().await;
    let Some(f) = fixture_full(true, false, Some(500)) else {
        return;
    };
    let _home = HomeGuard::set(f._t.path());
    let cb = |_: InstallStage, _: u8| {};
    let err = run_install(f.ctx.clone(), &cb, Arc::new(CancelToken::new()))
        .await
        .expect_err("deb download returns 500");
    assert_ne!(err.reason, UpdateReason::Cancelled);
    assert_eq!(version_of(&f.bin.join("vst")), "1.0.0", "vst untouched");
    assert!(!f.bin.join(".vst.prev").exists());
    assert!(!f.bin.join("claude-acp").exists());
}

#[tokio::test]
async fn deb_is_downloaded_before_replace_and_reported_d09() {
    let _g = LOCK.lock().await;
    let Some(f) = fixture_full(true, false, Some(200)) else {
        return;
    };
    let _home = HomeGuard::set(f._t.path());
    let (out, stages) = run(&f).await;
    assert_eq!(
        stages,
        [
            InstallStage::Preflight,
            InstallStage::Downloading,
            InstallStage::Verifying,
            InstallStage::Installing
        ],
        "no stage moves backwards"
    );
    assert!(out.result.deb_path.is_some());
    assert!(out.pending_restart.is_some());
    assert_eq!(version_of(&f.bin.join("vst")), "9.9.9");
}

// ---- UpdateService::start_install ------------------------------

use std::time::Duration;
use vst_daemon::update::{UpdateConfig, UpdateService};
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::update::{StartedBy, UpdateReason};

/// A service whose mock GitHub offers 9.9.9 with the fixture's assets, with
/// detection pinned to the fixture's targets (scripts fail the ELF check).
async fn service_for(f: &Fixture, b: Broadcaster) -> Arc<UpdateService> {
    let assets: Vec<String> = f
        .ctx
        .assets
        .iter()
        .map(|a| {
            format!(
                r#"{{"name":"{}","browser_download_url":"{}","size":{}}}"#,
                a.name, a.url, a.size
            )
        })
        .collect();
    let body = format!(
        r#"[{{"tag_name":"v9.9.9","prerelease":false,"draft":false,"body":"notes","html_url":"https://example.test/r","assets":[{}]}}]"#,
        assets.join(",")
    );
    let _m = mockito::mock("GET", "/svc7/releases?per_page=20")
        .with_body(body)
        .create();
    let svc = UpdateService::new(UpdateConfig {
        vst_home: f.ctx.vst_home.clone(),
        current_version: "0.1.0".into(),
        boot_exe: f.ctx.boot_exe.clone(),
        boot_id: "b".into(),
        api_base: format!("{}/svc7", mockito::server_url()),
        broadcaster: Some(b),
        check_interval: Duration::from_secs(3600),
        first_check_delay: Duration::from_secs(60),
        force_floor: Duration::from_secs(0),
    });
    svc.set_trusted_keys_for_tests(f.ctx.trusted_keys.clone());
    svc.check(true).await;
    svc.set_detected_for_tests(InstallMethod::Curl, f.ctx.targets.clone());
    svc
}

#[tokio::test]
async fn start_install_runs_to_idle_with_last_result_and_rejects_concurrent() {
    let _g = LOCK.lock().await;
    let Some(f) = fixture(true) else { return };
    let b = Broadcaster::new(64);
    let mut rx = b.subscribe();
    let svc = service_for(&f, b).await;

    let first = svc.start_install(StartedBy::Cli).expect("starts");
    assert!(first.install.is_some());
    // Second start while the first runs: update_in_progress, starter is cli.
    let second = svc.start_install(StartedBy::Ui).expect_err("busy");
    assert_eq!(second.reason, UpdateReason::UpdateInProgress);
    assert_eq!(
        svc.snapshot().install.map(|i| i.started_by),
        Some(StartedBy::Cli)
    );

    let mut stages = Vec::new();
    let mut installed = None;
    for _ in 0..200 {
        while let Ok(ev) = rx.try_recv() {
            match ev {
                ServerEvent::UpdateProgress { status } => {
                    if let Some(i) = status.install {
                        if stages.last() != Some(&i.stage) {
                            stages.push(i.stage);
                        }
                    }
                }
                ServerEvent::UpdateInstalled { status } => installed = Some(status),
                _ => {}
            }
        }
        if installed.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let done = installed.expect("update:installed published");
    assert_eq!(
        stages,
        [
            InstallStage::Preflight,
            InstallStage::Downloading,
            InstallStage::Verifying,
            InstallStage::Installing
        ]
    );
    assert!(done.install.is_none());
    assert_eq!(done.last_result.as_ref().unwrap().version, "9.9.9");
    assert!(done.restart_pending.is_some(), "boot exe was replaced");
    let snap = svc.snapshot();
    assert!(snap.install.is_none());
    assert!(snap.last_error.is_none());
    // Lock released: a new install can be attempted (fails only on "no update"
    // once current catches up, not on the lock).
    let again = svc.start_install(StartedBy::Ui);
    assert!(
        again.is_ok() || again.unwrap_err().reason != UpdateReason::UpdateInProgress,
        "lock released after install"
    );
}

// 2.T8: a signature that does not verify aborts before any asset download and
// leaves the installed binary byte-identical.
#[tokio::test]
async fn bad_signature_leaves_old_binary() {
    let _g = LOCK.lock().await;
    let Some(f) = fixture_with(true, true) else {
        return;
    };
    let before = std::fs::read(f.bin.join("vst")).unwrap();
    let asset_mock = mockito::mock("GET", format!("/itest/{}", f.ctx.assets[0].name).as_str())
        .expect(0)
        .create();
    let e = run_install(
        f.ctx.clone(),
        &|_s: InstallStage, _p: u8| {},
        Arc::new(CancelToken::new()),
    )
    .await
    .unwrap_err();
    assert_eq!(e.reason, UpdateReason::BadSignature);
    assert_eq!(std::fs::read(f.bin.join("vst")).unwrap(), before);
    assert!(!f.bin.join(".vst.prev").exists());
    asset_mock.assert();
}

fn read_only_dir(t: &Path) -> Option<PathBuf> {
    if vst_proc::posix::effective_uid() == 0 {
        return None; // root ignores 0555
    }
    let ro = t.join("ro-bin");
    std::fs::create_dir(&ro).unwrap();
    script(&ro.join("vst"), "1.0.0");
    std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o555)).unwrap();
    Some(ro)
}

fn curl_target(dir: &Path) -> UpdateTarget {
    UpdateTarget {
        method: InstallMethod::Curl,
        path: dir.join("vst").to_string_lossy().into_owned(),
        version: Some("1.0.0".into()),
        auto: true,
    }
}

#[tokio::test]
async fn unwritable_copy_becomes_manual_sudo_step_while_writable_installs() {
    let _g = LOCK.lock().await;
    let Some(mut f) = fixture(false) else { return };
    let Some(ro) = read_only_dir(f._t.path()) else {
        return;
    };
    f.ctx.targets.insert(0, curl_target(&ro));
    let (out, _) = run(&f).await;
    std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        out.result.updated,
        [f.bin.join("vst").to_string_lossy().into_owned()]
    );
    let want = format!("sudo sh -s -- --install-dir {}", ro.display());
    assert!(
        out.result.manual.iter().any(|s| s.text.contains(&want)),
        "{:?}",
        out.result.manual
    );
    // the read-only copy is untouched
    let v = std::process::Command::new(ro.join("vst"))
        .arg("--version")
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&v.stdout).trim(), "1.0.0");
}

#[tokio::test]
async fn permission_denied_only_when_no_writable_target_and_no_package_flow() {
    let _g = LOCK.lock().await;
    let Some(mut f) = fixture(false) else { return };
    let Some(ro) = read_only_dir(f._t.path()) else {
        return;
    };
    f.ctx.targets = vec![curl_target(&ro)];
    let err = run_install(f.ctx.clone(), &|_, _| {}, Arc::new(CancelToken::new())).await;
    std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o755)).unwrap();
    let e = err.unwrap_err();
    assert_eq!(
        e.reason,
        vst_types::rest::update::UpdateReason::PermissionDenied
    );
    assert!(
        e.message.contains("sudo sh -s -- --install-dir"),
        "{}",
        e.message
    );
}
