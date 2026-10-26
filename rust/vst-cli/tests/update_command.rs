//! `vst update --check` end-to-end: runs the real binary against a
//! temp `HOME`, a mock daemon (routes under `/api`, `/health` at root) and a
//! mock GitHub (`VST_UPDATE_API_BASE`).

use axum::{http::header, routing::get, Json, Router};
use serde_json::{json, Value};

async fn serve(app: Router) -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    port
}

fn status_json(update_available: bool) -> Value {
    let mut v: Value = serde_json::from_str(include_str!(
        "../../vst-types/tests/fixtures/wire/update-status.json"
    ))
    .unwrap();
    v["updateAvailable"] = json!(update_available);
    v["lastError"] = Value::Null;
    v["canInstall"] = json!(true);
    v
}

fn daemon_app(body: Value) -> Router {
    Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({"ok":true,"version":"1.0.0","port":1,"uptime":1,"bootId":"b"}))
            }),
        )
        .route("/api/update/check", get(move || async move { Json(body) }))
}

fn github_app(releases: Value) -> Router {
    Router::new().route("/releases", get(move || async move { Json(releases) }))
}

fn home_with_port(port: u16) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let vs = dir.path().join(".vibe-station");
    std::fs::create_dir_all(&vs).unwrap();
    std::fs::write(
        vs.join("config.json"),
        format!(r#"{{"port":{port},"cliToken":"tok"}}"#),
    )
    .unwrap();
    dir
}

async fn run_check(home: &std::path::Path, github: Option<u16>) -> (i32, String, String) {
    let home = home.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(env!("CARGO_BIN_EXE_vst"));
        cmd.args(["update", "--check"])
            .env("HOME", &home)
            .env_remove("VST_DAEMON_URL")
            .env_remove("VST_CLI_TOKEN")
            .env_remove("VST_DAEMON_TOKEN");
        if let Some(p) = github {
            cmd.env("VST_UPDATE_API_BASE", format!("http://127.0.0.1:{p}"));
        }
        let out = cmd.output().unwrap();
        (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        )
    })
    .await
    .unwrap()
}

fn newer_release() -> Value {
    json!([{"tag_name":"v99.0.0","prerelease":false,"draft":false,"body":"x",
            "html_url":"https://example.invalid/r","assets":[]}])
}

#[tokio::test(flavor = "multi_thread")]
async fn check_via_daemon_exits_10() {
    let port = serve(daemon_app(status_json(true))).await;
    let home = home_with_port(port);
    let (code, out, err) = run_check(home.path(), None).await;
    assert_eq!(code, 10, "stdout={out} stderr={err}");
    assert!(out.contains("v1.0.0 → v1.2.3"), "{out}");
}

#[tokio::test(flavor = "multi_thread")]
async fn check_via_daemon_up_to_date_exits_0() {
    let port = serve(daemon_app(status_json(false))).await;
    let home = home_with_port(port);
    let (code, out, err) = run_check(home.path(), None).await;
    assert_eq!(code, 0, "stderr={err}");
    assert!(out.contains("is already the latest version."), "{out}");
}

#[tokio::test(flavor = "multi_thread")]
async fn no_daemon_falls_back_in_process() {
    let gh = serve(github_app(newer_release())).await;
    // Port 1: nothing listening.
    let home = home_with_port(1);
    let (code, out, err) = run_check(home.path(), Some(gh)).await;
    assert_eq!(code, 10, "stdout={out} stderr={err}");
    assert!(out.contains("→ v99.0.0"), "{out}");
}

#[tokio::test(flavor = "multi_thread")]
async fn html_route_falls_back_in_process() {
    let app = Router::new()
        .route(
            "/health",
            get(|| async { Json(json!({"ok":true,"version":"1","port":1,"uptime":1})) }),
        )
        .route(
            "/api/update/check",
            get(|| async { ([(header::CONTENT_TYPE, "text/html")], "<html></html>") }),
        );
    let port = serve(app).await;
    let gh = serve(github_app(newer_release())).await;
    let home = home_with_port(port);
    let (code, out, err) = run_check(home.path(), Some(gh)).await;
    assert_eq!(code, 10, "stdout={out} stderr={err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn fallback_up_to_date_exits_0() {
    let gh = serve(github_app(json!([]))).await;
    let home = home_with_port(1);
    let (code, out, err) = run_check(home.path(), Some(gh)).await;
    assert_eq!(code, 0, "stdout={out} stderr={err}");
}

// ---- install flow ------------------------------------------------

use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

fn idle_status() -> Value {
    let mut v = status_json(true);
    for k in ["install", "restartPending", "lastResult", "rolledBack"] {
        v.as_object_mut().unwrap().remove(k);
    }
    v
}

/// GET /api/update/check walks: idle -> downloading -> installing -> done.
fn install_daemon(installs: Arc<AtomicUsize>, gets: Arc<AtomicUsize>, conflict: bool) -> Router {
    let g = gets.clone();
    let check = move || {
        let n = g.fetch_add(1, Ordering::SeqCst);
        async move {
            let mut v = idle_status();
            match n {
                0 => {}
                1 => v["install"] = json!({"stage":"downloading","pct":40,"startedBy":"cli"}),
                2 => v["install"] = json!({"stage":"installing","pct":50,"startedBy":"cli"}),
                _ => {
                    v["lastResult"] =
                        json!({"version":"1.2.3","updated":["/home/u/.local/bin/vst"],"manual":[]});
                    v["restartPending"] = json!({"version":"1.2.3","kind":"daemon"});
                }
            }
            Json(v)
        }
    };
    let install = move || {
        installs.fetch_add(1, Ordering::SeqCst);
        async move {
            if conflict {
                (
                    axum::http::StatusCode::CONFLICT,
                    Json(json!({"error":"update_in_progress","startedBy":"ui"})),
                )
            } else {
                (axum::http::StatusCode::ACCEPTED, Json(idle_status()))
            }
        }
    };
    Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({"ok":true,"version":"1.0.0","port":1,"uptime":1,"bootId":"b"}))
            }),
        )
        .route("/api/update/check", get(check))
        .route("/api/update/install", axum::routing::post(install))
}

/// Sign a one-asset SHA256SUMS manifest with a fresh throwaway Ed25519 key.
/// Returns (manifest, minisig, minisign-format .pub contents).
fn signed_manifest(tag: &str, name: &str, body: &[u8]) -> (String, String, String) {
    use base64::Engine as _;
    use ring::signature::{Ed25519KeyPair, KeyPair};
    let b64 = base64::engine::general_purpose::STANDARD;
    let kid = [3u8; 8];
    let kp = Ed25519KeyPair::from_seed_unchecked(&[5u8; 32]).unwrap();
    let hash: String = ring::digest::digest(&ring::digest::SHA256, body)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let man = format!("# vibe-station release manifest v1\n# tag={tag}\n{hash}  {name}\n");
    let sig = kp.sign(man.as_bytes());
    let tc = format!("vibe-station {tag}");
    let mut line = b"Ed".to_vec();
    line.extend_from_slice(&kid);
    line.extend_from_slice(sig.as_ref());
    let mut g = sig.as_ref().to_vec();
    g.extend_from_slice(tc.as_bytes());
    let minisig = format!(
        "untrusted comment: test\n{}\ntrusted comment: {tc}\n{}\n",
        b64.encode(line),
        b64.encode(kp.sign(&g).as_ref())
    );
    let mut pk = b"Ed".to_vec();
    pk.extend_from_slice(&kid);
    pk.extend_from_slice(kp.public_key().as_ref());
    (
        man,
        minisig,
        format!("untrusted comment: test\n{}\n", b64.encode(pk)),
    )
}

async fn run_update_args(
    home: &std::path::Path,
    exe: Option<&std::path::Path>,
    args: &[&str],
    github: Option<u16>,
    test_pubkey: Option<&str>,
) -> (i32, String, String) {
    let test_pubkey = test_pubkey.map(str::to_string);
    let home = home.to_path_buf();
    let exe = exe.map(|p| p.to_path_buf());
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(
            exe.unwrap_or_else(|| std::path::PathBuf::from(env!("CARGO_BIN_EXE_vst"))),
        );
        cmd.arg("update")
            .args(&args)
            .env("HOME", &home)
            // Keep `detect()` away from any real install on the host PATH.
            .env("PATH", &home)
            .env_remove("APPIMAGE")
            .env_remove("VST_DAEMON_URL")
            .env_remove("VST_CLI_TOKEN")
            .env_remove("VST_DAEMON_TOKEN")
            .stdin(std::process::Stdio::null());
        if let Some(k) = &test_pubkey {
            cmd.env("VST_TEST_RELEASE_PUBKEYS", k);
        }
        if let Some(p) = github {
            cmd.env("VST_UPDATE_API_BASE", format!("http://127.0.0.1:{p}"));
        }
        let out = cmd.output().unwrap();
        (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        )
    })
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn yes_happy_path_prints_stage_lines_and_exits_0() {
    let (installs, gets) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let port = serve(install_daemon(installs.clone(), gets, false)).await;
    let home = home_with_port(port);
    let (code, out, err) = run_update_args(home.path(), None, &["--yes"], None, None).await;
    assert_eq!(code, 0, "stdout={out} stderr={err}");
    assert_eq!(installs.load(Ordering::SeqCst), 1);
    for want in [
        "v1.0.0 → v1.2.3",
        "thing one",
        "Downloading ",
        "Installing…",
        "Updated to v1.2.3",
        "Restart the daemon to finish: vst daemon restart",
    ] {
        assert!(out.contains(want), "missing {want:?} in:\n{out}");
    }
    assert!(!out.contains("[2/4]"), "no step prefixes:\n{out}");
    assert!(
        !out.contains("Reload open vibe-station tabs"),
        "restart is pending, so no reload hint:\n{out}"
    );
}

/// The short `installing` stage is missed by the 500 ms poll; its line
/// must still be printed before the result.
#[tokio::test(flavor = "multi_thread")]
async fn missed_installing_stage_is_still_printed_before_done() {
    let gets = Arc::new(AtomicUsize::new(0));
    let g = gets.clone();
    let check = move || {
        let n = g.fetch_add(1, Ordering::SeqCst);
        async move {
            let mut v = idle_status();
            match n {
                0 => {}
                1 => v["install"] = json!({"stage":"preflight","pct":0,"startedBy":"cli"}),
                2 => v["install"] = json!({"stage":"verifying","pct":100,"startedBy":"cli"}),
                _ => {
                    v["lastResult"] =
                        json!({"version":"1.2.3","updated":["/home/u/.local/bin/vst"],"manual":[]});
                    v["restartPending"] = json!({"version":"1.2.3","kind":"daemon"});
                }
            }
            Json(v)
        }
    };
    let app = Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({"ok":true,"version":"1.0.0","port":1,"uptime":1,"bootId":"b"}))
            }),
        )
        .route("/api/update/check", get(check))
        .route(
            "/api/update/install",
            axum::routing::post(|| async {
                (axum::http::StatusCode::ACCEPTED, Json(idle_status()))
            }),
        );
    let port = serve(app).await;
    let home = home_with_port(port);
    let (code, out, err) = run_update_args(home.path(), None, &["--yes"], None, None).await;
    assert_eq!(code, 0, "stdout={out} stderr={err}");
    let at = |s: &str| {
        out.find(s)
            .unwrap_or_else(|| panic!("missing {s:?} in:\n{out}"))
    };
    assert!(at("Verifying checksum…") < at("Installing…"));
    assert!(at("Installing…") < at("Updated to"));
    assert!(!out.contains("Reload open vibe-station tabs"), "{out}");
}

#[tokio::test(flavor = "multi_thread")]
async fn non_tty_without_yes_refuses_and_does_not_install() {
    let (installs, gets) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let port = serve(install_daemon(installs.clone(), gets, false)).await;
    let home = home_with_port(port);
    let (code, out, err) = run_update_args(home.path(), None, &[], None, None).await;
    assert_eq!(code, 1, "stdout={out} stderr={err}");
    assert!(out.contains("v1.0.0 → v1.2.3"), "{out}");
    assert!(err.contains("re-run with --yes"), "{err}");
    assert_eq!(installs.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn conflict_409_reports_already_running() {
    let (installs, gets) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let port = serve(install_daemon(installs, gets, true)).await;
    let home = home_with_port(port);
    let (code, _out, err) = run_update_args(home.path(), None, &["--yes"], None, None).await;
    assert_eq!(code, 1);
    assert!(err.contains("An update is already running"), "{err}");
    assert!(err.contains("web UI"), "{err}");
}

fn tarball_with_vst(version: &str) -> Vec<u8> {
    let script = format!("#!/bin/sh\necho {version}\n");
    let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut b = tar::Builder::new(gz);
    let mut h = tar::Header::new_gnu();
    h.set_size(script.len() as u64);
    h.set_mode(0o755);
    h.set_cksum();
    b.append_data(&mut h, "vst", script.as_bytes()).unwrap();
    b.into_inner().unwrap().finish().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn old_daemon_falls_back_to_in_process_install() {
    use vst_daemon::update::platform::{assets_for, platform_key};
    let Some(asset) = assets_for(platform_key()).cli else {
        return; // host has no CLI release asset
    };
    let body = tarball_with_vst("99.0.0");
    let (man, sig, pubkey) = signed_manifest("v99.0.0", asset, &body);
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gh_port = l.local_addr().unwrap().port();
    let releases = json!([{"tag_name":"v99.0.0","prerelease":false,"draft":false,"body":"big release",
        "html_url":"https://example.invalid/r",
        "assets":[
            {"name":asset,"browser_download_url":format!("http://127.0.0.1:{gh_port}/dl/{asset}"),"size":body.len()},
            {"name":"SHA256SUMS","browser_download_url":format!("http://127.0.0.1:{gh_port}/dl/SHA256SUMS"),"size":man.len()},
            {"name":"SHA256SUMS.minisig","browser_download_url":format!("http://127.0.0.1:{gh_port}/dl/SHA256SUMS.minisig"),"size":sig.len()}]}]);
    let b2 = body.clone();
    let gh = Router::new()
        .route("/releases", get(move || async move { Json(releases) }))
        .route(&format!("/dl/{asset}"), get(move || async move { b2 }))
        .route("/dl/SHA256SUMS", get(move || async move { man }))
        .route("/dl/SHA256SUMS.minisig", get(move || async move { sig }));
    tokio::spawn(async move { axum::serve(l, gh).await.unwrap() });

    // Old daemon: answers /health only, so /api/update/check is a 404.
    let daemon = Router::new().route(
        "/health",
        get(|| async { Json(json!({"ok":true,"version":"0.0.1","port":1,"uptime":1})) }),
    );
    let port = serve(daemon).await;
    let home = home_with_port(port);
    let bin = home.path().join(".local/bin");
    std::fs::create_dir_all(&bin).unwrap();
    let exe = bin.join("vst");
    std::fs::copy(env!("CARGO_BIN_EXE_vst"), &exe).unwrap();
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();

    let (code, out, err) = run_update_args(
        home.path(),
        Some(&exe),
        &["--yes"],
        Some(gh_port),
        Some(&pubkey),
    )
    .await;
    assert_eq!(code, 0, "stdout={out} stderr={err}");
    assert!(
        out.contains("Daemon is too old for in-app updates; updating directly."),
        "{out}"
    );
    assert!(out.contains("Updated to v99.0.0"), "{out}");
    assert!(out.contains("The next `vst open` starts v99.0.0."), "{out}");
    assert!(bin.join(".vst.prev").exists(), "prev set kept");
    let v = std::process::Command::new(&exe)
        .arg("--version")
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&v.stdout).trim(), "99.0.0");
}

#[tokio::test(flavor = "multi_thread")]
async fn skip_without_daemon_persists_state() {
    let home = home_with_port(1);
    let (code, out, err) =
        run_update_args(home.path(), None, &["--skip", "9.9.9"], None, None).await;
    assert_eq!(code, 0, "stdout={out} stderr={err}");
    let saved =
        std::fs::read_to_string(home.path().join(".vibe-station/update-state.json")).unwrap();
    assert!(saved.contains("9.9.9"), "{saved}");
    let (code, _, err) =
        run_update_args(home.path(), None, &["--unskip", "9.9.9"], None, None).await;
    assert_eq!(code, 0, "{err}");
    let saved =
        std::fs::read_to_string(home.path().join(".vibe-station/update-state.json")).unwrap();
    assert!(!saved.contains("9.9.9"), "{saved}");
}

async fn run_raw_args(home: &std::path::Path, args: &[&str]) -> (i32, String, String) {
    let home = home.to_path_buf();
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(env!("CARGO_BIN_EXE_vst"));
        cmd.args(&args)
            .env("HOME", &home)
            .env("PATH", &home)
            .env_remove("APPIMAGE")
            .env_remove("VST_DAEMON_URL")
            .env_remove("VST_CLI_TOKEN")
            .env_remove("VST_DAEMON_TOKEN")
            .stdin(std::process::Stdio::null());
        let out = cmd.output().unwrap();
        (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).to_string(),
            String::from_utf8_lossy(&out.stderr).to_string(),
        )
    })
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn daemon_restart_yes_happy_path() {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    let boot_counter = Arc::new(AtomicU32::new(1));
    let bc = boot_counter.clone();

    let daemon = Router::new()
        .route(
            "/health",
            get(move || {
                let bc = bc.clone();
                async move {
                    let id = bc.load(Ordering::SeqCst);
                    Json(json!({"ok":true,"version":"1.0.0","port":1,"uptime":1,"bootId":format!("boot-{id}")}))
                }
            }),
        )
        .route(
            "/api/daemon/restart",
            axum::routing::post(move |body: axum::extract::Json<Value>| {
                let bc = boot_counter.clone();
                async move {
                    if body.get("confirm").and_then(|v| v.as_bool()) == Some(true) {
                        bc.store(2, Ordering::SeqCst);
                        (axum::http::StatusCode::ACCEPTED, Json(json!({"ok": true})))
                    } else {
                        (
                            axum::http::StatusCode::CONFLICT,
                            Json(json!({
                                "error": "restart_busy",
                                "impact": [{
                                    "sessionId": "s1",
                                    "name": "worker",
                                    "kind": "working"
                                }]
                            })),
                        )
                    }
                }
            }),
        );

    let port = serve(daemon).await;
    let home = home_with_port(port);

    let (code, out, err) = run_raw_args(home.path(), &["daemon", "restart", "--yes"]).await;
    assert_eq!(code, 0, "stdout={out} stderr={err}");
    assert!(out.contains("Restarted: v1.0.0"), "{out}");
}

#[tokio::test(flavor = "multi_thread")]
async fn daemon_restart_old_daemon_handles_404() {
    let daemon = Router::new().route(
        "/health",
        get(|| async { Json(json!({"ok":true,"version":"0.0.1","port":1,"uptime":1})) }),
    );
    let port = serve(daemon).await;
    let home = home_with_port(port);

    let (code, _out, err) = run_raw_args(home.path(), &["daemon", "restart", "--yes"]).await;
    // Will attempt POST /daemon/stop which is also 404 on this mock
    assert_ne!(code, 0);
    assert!(err.contains("Failed to request daemon stop"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn update_yes_with_impact_avoids_restart() {
    let check_calls = Arc::new(AtomicUsize::new(0));
    let cc = check_calls.clone();

    let check = move || {
        let n = cc.fetch_add(1, Ordering::SeqCst);
        async move {
            let mut v = idle_status();
            if n > 0 {
                v["lastResult"] =
                    json!({"version":"2.0.0","updated":["/home/u/.local/bin/vst"],"manual":[]});
                v["restartPending"] = json!({"version":"2.0.0","kind":"daemon"});
            }
            Json(v)
        }
    };

    let daemon = Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({"ok":true,"version":"1.0.0","port":1,"uptime":1,"bootId":"b"}))
            }),
        )
        .route("/api/update/check", get(check))
        .route(
            "/api/update/install",
            axum::routing::post(|| async {
                (axum::http::StatusCode::ACCEPTED, Json(json!({"ok": true})))
            }),
        )
        .route(
            "/api/daemon/restart",
            axum::routing::post(|body: axum::extract::Json<Value>| async move {
                if body.get("dryRun").and_then(|v| v.as_bool()) == Some(true) {
                    (
                        axum::http::StatusCode::OK,
                        Json(json!({
                            "impact": [{
                                "sessionId": "s1",
                                "name": "agent-1",
                                "kind": "working"
                            }]
                        })),
                    )
                } else {
                    (axum::http::StatusCode::ACCEPTED, Json(json!({"ok": true})))
                }
            }),
        );

    let port = serve(daemon).await;
    let home = home_with_port(port);

    let (code, out, err) = run_update_args(home.path(), None, &["--yes"], None, None).await;
    assert_eq!(code, 0, "stdout={out} stderr={err}");
    assert!(
        out.contains("Restart the daemon to finish: vst daemon restart"),
        "{out}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn dmg_only_prints_steps_and_url_exit_0() {
    let check_calls = Arc::new(AtomicUsize::new(0));
    let cc = check_calls.clone();

    let check = move || {
        let n = cc.fetch_add(1, Ordering::SeqCst);
        async move {
            let mut v = idle_status();
            v["targets"] = json!([{
                "method": "dmg",
                "path": "/Applications/vibe-station.app",
                "version": "1.0.0",
                "auto": false
            }]);
            if n > 0 {
                v["lastResult"] = json!({
                    "version": "1.2.3",
                    "updated": [],
                    "manual": [
                        {
                            "kind": "open_url",
                            "text": "Download vibe-station.dmg",
                            "url": "https://example.com/vibe-station.dmg"
                        },
                        {
                            "kind": "text",
                            "text": "1. Quit vibe-station.app (Cmd+Q)"
                        },
                        {
                            "kind": "text",
                            "text": "2. Open the downloaded .dmg and drag the app to /Applications (Replace)"
                        },
                        {
                            "kind": "text",
                            "text": "3. Relaunch vibe-station (if macOS blocks it: System Settings → Privacy & Security → Open Anyway)"
                        },
                        {
                            "kind": "open_url",
                            "text": "Checksum (optional): https://example.com/vibe-station.dmg.sha256",
                            "url": "https://example.com/vibe-station.dmg.sha256"
                        }
                    ]
                });
            }
            Json(v)
        }
    };

    let daemon = Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({"ok":true,"version":"1.0.0","port":1,"uptime":1,"bootId":"b"}))
            }),
        )
        .route("/api/update/check", get(check))
        .route(
            "/api/update/install",
            axum::routing::post(|| async {
                (axum::http::StatusCode::ACCEPTED, Json(json!({"ok": true})))
            }),
        );

    let port = serve(daemon).await;
    let home = home_with_port(port);

    let (code, out, err) = run_update_args(home.path(), None, &[], None, None).await;
    assert_eq!(code, 0, "stdout={out} stderr={err}");
    assert!(
        out.contains("https://example.com/vibe-station.dmg"),
        "{out}"
    );
    assert!(out.contains("Quit vibe-station.app"), "{out}");
    assert!(out.contains("Checksum (optional)"), "{out}");
}

#[tokio::test(flavor = "multi_thread")]
async fn deb_only_prints_verified_path_and_command_exit_0() {
    let check_calls = Arc::new(AtomicUsize::new(0));
    let cc = check_calls.clone();

    let check = move || {
        let n = cc.fetch_add(1, Ordering::SeqCst);
        async move {
            let mut v = idle_status();
            v["targets"] = json!([{
                "method": "deb",
                "path": "/usr/bin/vibe-station",
                "version": "1.0.0",
                "auto": false
            }]);
            if n > 0 {
                v["lastResult"] = json!({
                    "version": "1.2.3",
                    "updated": [],
                    "manual": [
                        {
                            "kind": "command",
                            "text": "sudo apt install /tmp/Downloads/vibe-station.deb"
                        },
                        {
                            "kind": "text",
                            "text": "Then quit and relaunch vibe-station."
                        }
                    ],
                    "debPath": "/tmp/Downloads/vibe-station.deb"
                });
            }
            Json(v)
        }
    };

    let daemon = Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({"ok":true,"version":"1.0.0","port":1,"uptime":1,"bootId":"b"}))
            }),
        )
        .route("/api/update/check", get(check))
        .route(
            "/api/update/install",
            axum::routing::post(|| async {
                (axum::http::StatusCode::ACCEPTED, Json(json!({"ok": true})))
            }),
        );

    let port = serve(daemon).await;
    let home = home_with_port(port);

    let (code, out, err) = run_update_args(home.path(), None, &["--yes"], None, None).await;
    assert_eq!(code, 0, "stdout={out} stderr={err}");
    assert!(
        out.contains("Downloaded and verified /tmp/Downloads/vibe-station.deb"),
        "{out}"
    );
    assert!(
        out.contains("sudo apt install /tmp/Downloads/vibe-station.deb"),
        "{out}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn deb_only_non_tty_without_yes_refuses_and_does_not_install_d20() {
    let installs = Arc::new(AtomicUsize::new(0));
    let ic = installs.clone();
    let check = || async {
        let mut v = idle_status();
        v["targets"] = json!([{
            "method": "deb",
            "path": "/usr/bin/vibe-station",
            "version": "1.0.0",
            "auto": false
        }]);
        Json(v)
    };
    let daemon = Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({"ok":true,"version":"1.0.0","port":1,"uptime":1,"bootId":"b"}))
            }),
        )
        .route("/api/update/check", get(check))
        .route(
            "/api/update/install",
            axum::routing::post(move || {
                ic.fetch_add(1, Ordering::SeqCst);
                async { (axum::http::StatusCode::ACCEPTED, Json(json!({"ok": true}))) }
            }),
        );
    let port = serve(daemon).await;
    let home = home_with_port(port);
    let (code, out, err) = run_update_args(home.path(), None, &[], None, None).await;
    assert_eq!(code, 1, "stdout={out} stderr={err}");
    assert!(err.contains("re-run with --yes"), "{err}");
    assert_eq!(
        installs.load(Ordering::SeqCst),
        0,
        "no POST /api/update/install"
    );
}

/// A 401 from a live daemon is an auth problem, not "daemon too old", and
/// must not fall back to an in-process install.
#[tokio::test(flavor = "multi_thread")]
async fn unauthorized_daemon_does_not_fall_back_d16() {
    let app = Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({"ok":true,"version":"1.0.0","port":1,"uptime":1,"bootId":"b"}))
            }),
        )
        .route(
            "/api/update/check",
            get(|| async {
                (
                    axum::http::StatusCode::UNAUTHORIZED,
                    Json(json!({"error":"unauthorized"})),
                )
            }),
        );
    let port = serve(app).await;
    let home = home_with_port(port);
    let gh = serve(github_app(newer_release())).await;
    let (code, out, err) = run_update_args(home.path(), None, &["--yes"], Some(gh), None).await;
    assert_eq!(code, 1, "stdout={out} stderr={err}");
    assert!(err.contains("vst open"), "{err}");
    assert!(
        !out.contains("too old") && !err.contains("too old"),
        "{out}{err}"
    );
    assert!(!out.contains("Updated to"), "{out}");
    // `--check` takes the same path.
    let (code, out, err) = run_check(home.path(), Some(gh)).await;
    assert_eq!(code, 1, "stdout={out} stderr={err}");
    assert!(err.contains("vst open"), "{err}");
}

/// SIGINT during the daemon-less download cancels cleanly (exit 130),
/// leaving the installed `vst` untouched and no `.vst.new` behind.
#[tokio::test(flavor = "multi_thread")]
async fn fallback_sigint_during_download_cancels_cleanly_d21() {
    use std::io::{BufRead, BufReader};
    use vst_daemon::update::platform::{assets_for, platform_key};
    let Some(asset) = assets_for(platform_key()).cli else {
        return; // host has no CLI release asset
    };
    let body = tarball_with_vst("99.0.0");
    let (man, sig, pubkey) = signed_manifest("v99.0.0", asset, &body);
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gh_port = l.local_addr().unwrap().port();
    let releases = json!([{"tag_name":"v99.0.0","prerelease":false,"draft":false,"body":"big release",
        "html_url":"https://example.invalid/r",
        "assets":[
            {"name":asset,"browser_download_url":format!("http://127.0.0.1:{gh_port}/dl/{asset}"),"size":body.len()},
            {"name":"SHA256SUMS","browser_download_url":format!("http://127.0.0.1:{gh_port}/dl/SHA256SUMS"),"size":man.len()},
            {"name":"SHA256SUMS.minisig","browser_download_url":format!("http://127.0.0.1:{gh_port}/dl/SHA256SUMS.minisig"),"size":sig.len()}]}]);
    let gh = Router::new()
        .route("/releases", get(move || async move { Json(releases) }))
        .route(
            &format!("/dl/{asset}"),
            get(move || async move {
                // A download that never finishes within the test.
                tokio::time::sleep(std::time::Duration::from_secs(120)).await;
                body
            }),
        )
        .route("/dl/SHA256SUMS", get(move || async move { man }))
        .route("/dl/SHA256SUMS.minisig", get(move || async move { sig }));
    tokio::spawn(async move { axum::serve(l, gh).await.unwrap() });

    let home = home_with_port(1); // no daemon: fallback path
    let bin = home.path().join(".local/bin");
    std::fs::create_dir_all(&bin).unwrap();
    let exe = bin.join("vst");
    std::fs::copy(env!("CARGO_BIN_EXE_vst"), &exe).unwrap();
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
    let before = std::fs::read(&exe).unwrap();

    let (hp, e2) = (home.path().to_path_buf(), exe.clone());
    let (code, out) = tokio::task::spawn_blocking(move || {
        let mut child = std::process::Command::new(&e2)
            .args(["update", "--yes"])
            .env("HOME", &hp)
            .env("PATH", &hp)
            .env_remove("APPIMAGE")
            .env_remove("VST_DAEMON_URL")
            .env_remove("VST_CLI_TOKEN")
            .env_remove("VST_DAEMON_TOKEN")
            .env("VST_UPDATE_API_BASE", format!("http://127.0.0.1:{gh_port}"))
            .env("VST_TEST_RELEASE_PUBKEYS", &pubkey)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut seen = String::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap() == 0 {
                break;
            }
            seen.push_str(&line);
            if line.contains("Downloading") {
                // Let the download request get in flight, then interrupt.
                std::thread::sleep(std::time::Duration::from_millis(500));
                let _ = std::process::Command::new("kill")
                    .args(["-INT", &child.id().to_string()])
                    .status();
                break;
            }
        }
        let status = child.wait().unwrap();
        (status.code().unwrap_or(-1), seen)
    })
    .await
    .unwrap();
    assert_eq!(code, 130, "stdout={out}");
    assert_eq!(std::fs::read(&exe).unwrap(), before, "bin/vst unchanged");
    assert!(!bin.join(".vst.new").exists());
    assert!(!bin.join(".vst.prev").exists());
}

/// After a rollback the daemon reports `updateAvailable:false` for the
/// failed version; the CLI must not claim "already the latest" and
/// `vst update --yes` must still POST the install.
fn rolled_back_status() -> Value {
    let mut v = idle_status();
    v["current"] = json!("1.0.0");
    v["latest"] = json!("1.2.3");
    v["updateAvailable"] = json!(false);
    v["rolledBack"] = json!({"failedVersion":"1.2.3","at":"2026-10-26T00:00:00Z"});
    v
}

fn rolled_back_daemon(installs: Arc<AtomicUsize>) -> Router {
    Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({"ok":true,"version":"1.0.0","port":1,"uptime":1,"bootId":"b"}))
            }),
        )
        .route(
            "/api/update/check",
            get(|| async { Json(rolled_back_status()) }),
        )
        .route(
            "/api/update/install",
            axum::routing::post(move || {
                installs.fetch_add(1, Ordering::SeqCst);
                async { (axum::http::StatusCode::ACCEPTED, Json(rolled_back_status())) }
            }),
        )
}

#[tokio::test(flavor = "multi_thread")]
async fn check_after_rollback_names_the_failed_version_exit_0() {
    let installs = Arc::new(AtomicUsize::new(0));
    let port = serve(rolled_back_daemon(installs.clone())).await;
    let home = home_with_port(port);
    let (code, out, err) = run_update_args(home.path(), None, &["--check"], None, None).await;
    assert_eq!(code, 0, "stdout={out} stderr={err}");
    assert!(out.contains("failed to start"), "{out}");
    assert!(out.contains("vst update --skip 1.2.3"), "{out}");
    assert!(!out.contains("already the latest"), "{out}");
    assert_eq!(installs.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn yes_after_rollback_posts_the_install() {
    let installs = Arc::new(AtomicUsize::new(0));
    let port = serve(rolled_back_daemon(installs.clone())).await;
    let home = home_with_port(port);
    let (_code, out, err) = run_update_args(home.path(), None, &["--yes"], None, None).await;
    assert!(out.contains("Retrying the install."), "{out}\n{err}");
    assert_eq!(installs.load(Ordering::SeqCst), 1, "{out}\n{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn update_help_prints_usage_and_makes_no_request() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    let hits = Arc::new(AtomicUsize::new(0));
    let h = hits.clone();
    let app = Router::new().fallback(move || {
        let h = h.clone();
        async move {
            h.fetch_add(1, Ordering::SeqCst);
            "x"
        }
    });
    let port = serve(app).await;
    let home = home_with_port(port);
    let hp = home.path().to_path_buf();
    let out = tokio::task::spawn_blocking(move || {
        std::process::Command::new(env!("CARGO_BIN_EXE_vst"))
            .args(["update", "--help"])
            .env("HOME", &hp)
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    assert_eq!(out.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("mv .<name>.prev <name>"), "{stdout}");
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}
