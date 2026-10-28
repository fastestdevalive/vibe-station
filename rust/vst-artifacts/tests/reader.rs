//! 2.T9: the hardened reader against a real file system.

mod common;

use std::os::unix::fs::{symlink, PermissionsExt};
use std::time::{Duration, Instant};

use common::Env;
use vst_artifacts::reader::{open_artifact, DenyCtx, ReadError, IMAGE_CAP_BYTES, TEXT_CAP_BYTES};
use vst_artifacts::ReadOutcome;
use vst_types::artifacts::ArtifactState;

async fn id_of(env: &Env, path: &std::path::Path) -> String {
    env.handle
        .list(&env.scope)
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|r| r.path == path.to_string_lossy())
        .expect("row")
        .id
}

#[tokio::test]
async fn text_is_cut_on_a_utf8_boundary_with_the_total() {
    let env = Env::new().await;
    // 3-byte characters: 1 MiB is not a multiple of 3, so the cut must back off.
    let body = "\u{20ac}".repeat(500_000);
    let f = env.file(&env.out("big.md"), &body);
    env.write_now("sess-a", &f).await;
    let id = id_of(&env, &f).await;
    match env.handle.read_content(&id).await {
        ReadOutcome::Text {
            bytes,
            total,
            truncated,
            etag,
        } => {
            assert!(truncated);
            assert_eq!(total, body.len() as u64);
            assert!(bytes.len() <= TEXT_CAP_BYTES);
            assert_eq!(bytes.len(), TEXT_CAP_BYTES / 3 * 3);
            assert!(
                std::str::from_utf8(&bytes).is_ok(),
                "valid UTF-8 after the cut"
            );
            assert!(!etag.is_empty());
        }
        other => panic!("{other:?}"),
    }
    let small = env.file(&env.out("small.md"), "hello");
    env.write_now("sess-a", &small).await;
    let id = id_of(&env, &small).await;
    match env.handle.read_content(&id).await {
        ReadOutcome::Text {
            bytes,
            total,
            truncated,
            ..
        } => {
            assert_eq!(
                (bytes.as_slice(), total, truncated),
                (b"hello".as_slice(), 5, false)
            );
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn branch_order_image_then_binary_then_text() {
    let env = Env::new().await;
    let png = env.file(
        &env.out("a.png"),
        "not really a png but an image by extension",
    );
    let bin = env.file(&env.out("b.md"), "abc\0def");
    let zip = env.file(&env.out("c.zip"), "PK\0\0data");
    let txt = env.file(&env.out("d.txt"), "plain text");
    for p in [&png, &bin, &zip, &txt] {
        env.write_now("sess-a", p).await;
    }
    match env.handle.read_content(&id_of(&env, &png).await).await {
        ReadOutcome::Image { mime, bytes, .. } => {
            assert_eq!(mime, "image/png");
            assert!(!bytes.is_empty());
        }
        other => panic!("{other:?}"),
    }
    for p in [&bin, &zip] {
        assert!(matches!(
            env.handle.read_content(&id_of(&env, p).await).await,
            ReadOutcome::Binary { size, .. } if size > 0
        ));
    }
    assert!(matches!(
        env.handle.read_content(&id_of(&env, &txt).await).await,
        ReadOutcome::Text { .. }
    ));
}

#[tokio::test]
async fn oversize_image_is_too_large() {
    let env = Env::new().await;
    let f = env.out("huge.png");
    std::fs::File::create(&f)
        .unwrap()
        .set_len(IMAGE_CAP_BYTES + 1)
        .unwrap();
    env.write_now("sess-a", &f).await;
    let id = id_of(&env, &f).await;
    assert!(matches!(
        env.handle.read_content(&id).await,
        ReadOutcome::TooLarge { size } if size == IMAGE_CAP_BYTES + 1
    ));
}

#[tokio::test]
async fn permission_denied_is_unreadable() {
    if running_as_root() {
        eprintln!("skipped: running as root");
        return;
    }
    let env = Env::new().await;
    let f = env.file(&env.out("locked.md"), "secret-ish");
    env.write_now("sess-a", &f).await;
    let id = id_of(&env, &f).await;
    std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o000)).unwrap();
    match env.handle.read_content(&id).await {
        ReadOutcome::Unreadable { detail } => assert_eq!(detail, "EACCES"),
        other => panic!("{other:?}"),
    }
    std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
}

fn running_as_root() -> bool {
    std::process::Command::new("id")
        .arg("-u")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
        .unwrap_or(false)
}

#[tokio::test]
async fn deleted_file_is_missing_and_announced() {
    let mut env = Env::new().await;
    let f = env.file(&env.out("gone.md"), "x");
    env.write_now("sess-a", &f).await;
    let id = id_of(&env, &f).await;
    let _ = env.events();
    std::fs::remove_file(&f).unwrap();
    assert!(matches!(
        env.handle.read_content(&id).await,
        ReadOutcome::Missing
    ));
    let ev = env.events();
    assert!(ev.iter().any(|e| matches!(e, vst_types::ServerEvent::ArtifactUpserted { rows, .. } if rows.iter().any(|r| r.row.state == ArtifactState::Missing))));
}

#[tokio::test]
async fn fifo_is_refused_without_blocking() {
    let env = Env::new().await;
    let f = env.file(&env.out("pipe.md"), "x");
    env.write_now("sess-a", &f).await;
    let id = id_of(&env, &f).await;
    std::fs::remove_file(&f).unwrap();
    let st = std::process::Command::new("mkfifo")
        .arg(&f)
        .status()
        .unwrap();
    assert!(st.success());
    let start = Instant::now();
    let out = tokio::time::timeout(Duration::from_secs(5), env.handle.read_content(&id))
        .await
        .expect("must not hang on a writer-less FIFO");
    // Completing at all (the 5 s timeout above) is the contract; the elapsed
    // time is machine dependent.
    let _ = start.elapsed();
    assert!(matches!(out, ReadOutcome::Denied), "{out:?}");
}

#[tokio::test]
async fn a_symlink_swapped_in_after_recording_is_refused() {
    let env = Env::new().await;
    let f = env.file(&env.out("swap.md"), "innocent");
    env.write_now("sess-a", &f).await;
    let id = id_of(&env, &f).await;
    let secret = env.file(&env.out("elsewhere.md"), "other");
    std::fs::remove_file(&f).unwrap();
    symlink(&secret, &f).unwrap();
    assert!(matches!(
        env.handle.read_content(&id).await,
        ReadOutcome::Denied
    ));
    // A symlinked PARENT is refused as well (canonical path differs).
    let dir = env.out("d");
    let inner = env.file(&dir.join("x.md"), "x");
    env.write_now("sess-a", &inner).await;
    let id2 = id_of(&env, &inner).await;
    let moved = env.base.join("moved-d");
    std::fs::rename(&dir, &moved).unwrap();
    symlink(&moved, &dir).unwrap();
    assert!(matches!(
        env.handle.read_content(&id2).await,
        ReadOutcome::Denied
    ));
}

#[tokio::test]
async fn hard_link_outside_the_repo_is_refused_inside_is_served() {
    let env = Env::new().await;
    let out = env.file(&env.out("linked.md"), "payload");
    env.write_now("sess-a", &out).await;
    let id = id_of(&env, &out).await;
    assert!(matches!(
        env.handle.read_content(&id).await,
        ReadOutcome::Text { .. }
    ));
    std::fs::hard_link(&out, env.out("alias.md")).unwrap();
    assert!(matches!(
        env.handle.read_content(&id).await,
        ReadOutcome::Denied
    ));

    let inrepo = env.file(&env.root.join("docs/in.md"), "inside");
    env.write_now("sess-a", &inrepo).await;
    let id2 = id_of(&env, &inrepo).await;
    std::fs::hard_link(&inrepo, env.root.join("docs/in-alias.md")).unwrap();
    assert!(matches!(
        env.handle.read_content(&id2).await,
        ReadOutcome::Text { .. }
    ));
}

#[tokio::test]
async fn open_artifact_gate_order_directly() {
    let env = Env::new().await;
    let deny = DenyCtx {
        vst_home: env.vst_home.clone(),
        registered_roots: vec![],
    };
    let f = env.file(&env.out("ok.md"), "ok");
    assert!(open_artifact(&f, false, &deny).is_ok());
    // Not canonical (extra `.` hop through a symlink) -> PathChanged.
    symlink(&env.outside, env.base.join("o")).unwrap();
    assert!(matches!(
        open_artifact(&env.base.join("o/ok.md"), false, &deny),
        Err(ReadError::PathChanged)
    ));
    // Directory -> Denied (regular-file check on the open fd).
    assert!(matches!(
        open_artifact(&env.outside, false, &deny),
        Err(ReadError::Denied)
    ));
    // Denylisted name -> Denied before any open.
    let key = env.file(&env.out("k.pem"), "k");
    assert!(matches!(
        open_artifact(&key, false, &deny),
        Err(ReadError::Denied)
    ));
    assert!(matches!(
        open_artifact(&env.out("nope.md"), false, &deny),
        Err(ReadError::NotFound)
    ));
}

#[tokio::test]
async fn authorize_read_requires_a_live_row_with_the_exact_canonical_path() {
    let env = Env::new().await;
    let f = env.file(&env.out("auth.md"), "a");
    env.write_now("sess-a", &f).await;
    let id = id_of(&env, &f).await;
    assert_eq!(
        env.handle.authorize_read(&env.scope, &f).await,
        Some(id.clone())
    );
    assert_eq!(
        env.handle
            .authorize_read(&vst_types::artifacts::ScopeKey::worktree("other"), &f)
            .await,
        None,
        "the allowlist is per scope"
    );
    assert_eq!(
        env.handle
            .authorize_read(&env.scope, &env.out("zzz.md"))
            .await,
        None
    );
    env.handle.remove(&id).await.unwrap();
    assert_eq!(
        env.handle.authorize_read(&env.scope, &f).await,
        None,
        "hidden rows do not authorize"
    );
}

#[test]
fn a_parent_directory_swapped_for_a_symlink_after_the_check_is_refused() {
    use vst_artifacts::reader::{fd_real_path, verify_open_path};
    let d = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(d.path()).unwrap();
    std::fs::create_dir_all(base.join("secret")).unwrap();
    std::fs::write(base.join("secret/f.txt"), "creds").unwrap();
    std::fs::create_dir_all(base.join("repo")).unwrap();
    let canon = base.join("repo/f.txt");
    // `repo` is swapped for a symlink to `secret` between check and open.
    std::fs::remove_dir_all(base.join("repo")).unwrap();
    symlink(base.join("secret"), base.join("repo")).unwrap();
    let file = std::fs::File::open(&canon).unwrap();
    let real = fd_real_path(&file).expect("fd path on macOS/Linux");
    assert_eq!(real, base.join("secret/f.txt"));
    let deny = DenyCtx::default();
    assert!(matches!(
        verify_open_path(&file, &canon, &deny),
        Err(ReadError::PathChanged)
    ));
    // The honest path passes.
    let ok = std::fs::File::open(base.join("secret/f.txt")).unwrap();
    verify_open_path(&ok, &base.join("secret/f.txt"), &deny).unwrap();
    // A real path that is denylisted is refused even when it equals `canon`.
    let home = base.join("home");
    std::fs::create_dir_all(home.join(".aws")).unwrap();
    std::fs::write(home.join(".aws/credentials"), "k").unwrap();
    let aws = std::fs::File::open(home.join(".aws/credentials")).unwrap();
    let deny = DenyCtx {
        vst_home: home.join(".vibe-station"),
        registered_roots: vec![],
    };
    assert!(matches!(
        verify_open_path(&aws, &home.join(".aws/credentials"), &deny),
        Err(ReadError::Denied)
    ));
}
