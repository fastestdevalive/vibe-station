//! Behaviour contract for `PathWatcher`: the directory budget, eviction and
//! restore, registration off the async runtime, and real `notify` events for
//! commented files and a linked worktree's git state.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::broadcast;
use vst_fswatch::path_watcher::{DirBackend, PathWatcher, WatchEvent, WATCHED_DIR_LIMIT};
use vst_types::artifacts::ScopeKey;

#[derive(Default)]
struct Fake {
    watched: Mutex<Vec<PathBuf>>,
    unwatched: Mutex<Vec<PathBuf>>,
    /// When set, `watch_dir` blocks until a message arrives.
    gate: Mutex<Option<std_mpsc::Receiver<()>>>,
}

impl DirBackend for Fake {
    fn watch_dir(&self, dir: &Path) -> Result<(), String> {
        if let Some(rx) = self.gate.lock().unwrap().as_ref() {
            let _ = rx.recv();
        }
        self.watched.lock().unwrap().push(dir.to_path_buf());
        Ok(())
    }
    fn unwatch_dir(&self, dir: &Path) {
        self.unwatched.lock().unwrap().push(dir.to_path_buf());
    }
}

fn fake_watcher(
    limit: usize,
) -> (
    PathWatcher,
    Arc<Fake>,
    tokio::sync::mpsc::UnboundedSender<PathBuf>,
) {
    let fake = Arc::new(Fake::default());
    let sender = Arc::new(Mutex::new(None));
    let (f, s) = (Arc::clone(&fake), Arc::clone(&sender));
    let w = PathWatcher::with_backend(
        move |tx| {
            *s.lock().unwrap() = Some(tx);
            f as Arc<dyn DirBackend>
        },
        limit,
    );
    let tx = sender.lock().unwrap().take().unwrap();
    (w, fake, tx)
}

fn scope() -> ScopeKey {
    ScopeKey::worktree("wt-1")
}

async fn next_event(rx: &mut broadcast::Receiver<WatchEvent>) -> WatchEvent {
    tokio::time::timeout(Duration::from_secs(8), rx.recv())
        .await
        .expect("event within 8s")
        .expect("channel open")
}

#[tokio::test]
async fn three_hundred_paths_in_one_dir_use_one_slot() {
    let (w, fake, _tx) = fake_watcher(WATCHED_DIR_LIMIT);
    for i in 0..300 {
        w.watch(&scope(), Path::new(&format!("/virt/one/f{i}.rs")), "0001")
            .await;
    }
    assert_eq!(w.watched_dir_count(), 1);
    assert_eq!(fake.watched.lock().unwrap().len(), 1);
    assert_eq!(w.registered(&scope()).len(), 300);
}

#[tokio::test]
async fn the_201st_dir_evicts_the_oldest_newest_and_a_free_slot_restores_it() {
    let (w, fake, _tx) = fake_watcher(WATCHED_DIR_LIMIT);
    let mut rx = w.subscribe();
    for i in 0..WATCHED_DIR_LIMIT {
        w.watch(
            &scope(),
            Path::new(&format!("/virt/d{i:03}/a.rs")),
            &format!("{:04}", i + 10),
        )
        .await;
    }
    assert_eq!(w.watched_dir_count(), WATCHED_DIR_LIMIT);
    // d000 has the oldest newest-comment (stamp 0010). A second, even older
    // comment elsewhere does not change that: the dir's rank is its NEWEST one.
    w.watch(&scope(), Path::new("/virt/d000/b.rs"), "0005")
        .await;
    assert!(rx.try_recv().is_err(), "no eviction yet");

    // The 201st distinct dir is the newest: d000 loses its watch.
    w.watch(&scope(), Path::new("/virt/new/a.rs"), "9999").await;
    assert_eq!(w.watched_dir_count(), WATCHED_DIR_LIMIT);
    let WatchEvent::Evicted { paths } = next_event(&mut rx).await else {
        panic!("expected Evicted");
    };
    let mut got: Vec<_> = paths.iter().map(|(_, p)| p.clone()).collect();
    got.sort();
    assert_eq!(
        got,
        vec![
            PathBuf::from("/virt/d000/a.rs"),
            PathBuf::from("/virt/d000/b.rs")
        ]
    );
    assert!(w.is_evicted(&scope(), Path::new("/virt/d000/a.rs")));
    assert!(fake
        .unwatched
        .lock()
        .unwrap()
        .contains(&PathBuf::from("/virt/d000")));

    // Removing the only comment of another dir frees a slot: d000 is back.
    w.unwatch(&scope(), Path::new("/virt/d150/a.rs")).await;
    let WatchEvent::Restored { paths } = next_event(&mut rx).await else {
        panic!("expected Restored");
    };
    assert_eq!(paths.len(), 2);
    assert!(!w.is_evicted(&scope(), Path::new("/virt/d000/a.rs")));
    assert_eq!(w.watched_dir_count(), WATCHED_DIR_LIMIT);
}

#[tokio::test]
async fn a_new_dir_older_than_everything_is_itself_over_budget() {
    let (w, _fake, _tx) = fake_watcher(2);
    let mut rx = w.subscribe();
    w.watch(&scope(), Path::new("/virt/a/x.rs"), "0020").await;
    w.watch(&scope(), Path::new("/virt/b/x.rs"), "0030").await;
    w.watch(&scope(), Path::new("/virt/c/x.rs"), "0010").await;
    let WatchEvent::Evicted { paths } = next_event(&mut rx).await else {
        panic!("expected Evicted");
    };
    assert_eq!(paths[0].1, PathBuf::from("/virt/c/x.rs"));
}

#[tokio::test]
async fn removing_the_last_comment_in_a_dir_drops_its_watch() {
    let (w, fake, _tx) = fake_watcher(WATCHED_DIR_LIMIT);
    w.watch(&scope(), Path::new("/virt/d/a.rs"), "1").await;
    w.watch(&scope(), Path::new("/virt/d/b.rs"), "2").await;
    w.unwatch(&scope(), Path::new("/virt/d/a.rs")).await;
    assert_eq!(w.watched_dir_count(), 1, "b.rs still needs the dir");
    assert!(fake.unwatched.lock().unwrap().is_empty());
    w.unwatch(&scope(), Path::new("/virt/d/b.rs")).await;
    assert_eq!(w.watched_dir_count(), 0);
    assert_eq!(fake.unwatched.lock().unwrap().len(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn registration_runs_on_a_blocking_thread_not_the_runtime() {
    let (w, fake, _tx) = fake_watcher(WATCHED_DIR_LIMIT);
    let (release, gate) = std_mpsc::channel();
    *fake.gate.lock().unwrap() = Some(gate);

    let w2 = w.clone();
    let task = tokio::spawn(async move {
        w2.watch(&scope(), Path::new("/virt/slow/a.rs"), "1").await;
    });
    // `watch_dir` is now (or about to be) blocked. A single-threaded runtime
    // still makes progress, so the blocking call is not on it.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!task.is_finished(), "watch is still registering");
    assert_eq!(fake.watched.lock().unwrap().len(), 0);

    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("watch finishes once released")
        .unwrap();
    assert_eq!(fake.watched.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn raw_events_map_to_registered_paths_only() {
    let (w, _fake, tx) = fake_watcher(WATCHED_DIR_LIMIT);
    let mut rx = w.subscribe();
    w.watch(&scope(), Path::new("/virt/d/a.rs"), "1").await;
    tx.send(PathBuf::from("/virt/d/other.rs")).unwrap();
    tx.send(PathBuf::from("/virt/d/a.rs")).unwrap();
    assert_eq!(
        next_event(&mut rx).await,
        WatchEvent::PathChanged {
            scope: scope(),
            path: PathBuf::from("/virt/d/a.rs")
        }
    );
    assert!(
        rx.try_recv().is_err(),
        "the unregistered sibling is filtered"
    );
}

#[tokio::test]
async fn unwatch_scope_drops_every_path_of_that_scope() {
    let (w, _fake, _tx) = fake_watcher(WATCHED_DIR_LIMIT);
    let other = ScopeKey::worktree("wt-2");
    w.watch(&scope(), Path::new("/virt/d/a.rs"), "1").await;
    w.watch(&other, Path::new("/virt/d/a.rs"), "2").await;
    w.unwatch_scope(&scope()).await;
    assert!(w.registered(&scope()).is_empty());
    assert_eq!(w.registered(&other).len(), 1);
    assert_eq!(w.watched_dir_count(), 1);
}

#[tokio::test]
async fn real_notify_reports_changes_and_atomic_replaces_of_a_commented_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.txt");
    fs::write(&file, "one").unwrap();
    fs::write(dir.path().join("b.txt"), "x").unwrap();
    let w = PathWatcher::native().expect("native watcher");
    let mut rx = w.subscribe();
    w.watch(&scope(), &file, "1").await;

    fs::write(dir.path().join("b.txt"), "ignored").unwrap();
    fs::write(&file, "two").unwrap();
    let ev = next_event(&mut rx).await;
    assert_eq!(
        ev,
        WatchEvent::PathChanged {
            scope: scope(),
            path: file.clone()
        }
    );

    // An editor's atomic save: write a temp file, rename over the target.
    let tmp = dir.path().join("a.txt.tmp");
    fs::write(&tmp, "three").unwrap();
    fs::rename(&tmp, &file).unwrap();
    let ev = next_event(&mut rx).await;
    assert!(matches!(ev, WatchEvent::PathChanged { ref path, .. } if path == &file));

    fs::remove_file(&file).unwrap();
    let ev = next_event(&mut rx).await;
    assert!(matches!(ev, WatchEvent::PathChanged { ref path, .. } if path == &file));
}

#[tokio::test]
async fn a_linked_worktree_git_dir_head_change_emits_git_state_changed() {
    // <main>/.git/worktrees/wt-1 holds HEAD / index / logs/HEAD of the linked
    // worktree; none of it is under the worktree root.
    let main = tempfile::tempdir().unwrap();
    let gitdir = main.path().join(".git").join("worktrees").join("wt-1");
    fs::create_dir_all(gitdir.join("logs")).unwrap();
    fs::write(gitdir.join("HEAD"), "ref: refs/heads/a\n").unwrap();
    fs::write(gitdir.join("index"), "i").unwrap();
    fs::write(gitdir.join("logs").join("HEAD"), "l").unwrap();
    fs::write(gitdir.join("ORIG_HEAD"), "o").unwrap();

    let w = PathWatcher::native().expect("native watcher");
    let mut rx = w.subscribe();
    w.watch_git_state("wt-1", &gitdir).await;
    assert!(w.watches_git_state("wt-1"));
    assert_eq!(w.watched_dir_count(), 0, "git dirs are outside the budget");

    fs::write(gitdir.join("ORIG_HEAD"), "noise").unwrap();
    fs::write(gitdir.join("HEAD"), "ref: refs/heads/b\n").unwrap();
    assert_eq!(
        next_event(&mut rx).await,
        WatchEvent::GitStateChanged {
            worktree_id: "wt-1".into()
        }
    );
    fs::write(gitdir.join("logs").join("HEAD"), "l2").unwrap();
    assert_eq!(
        next_event(&mut rx).await,
        WatchEvent::GitStateChanged {
            worktree_id: "wt-1".into()
        }
    );

    w.unwatch_git_state("wt-1").await;
    assert!(!w.watches_git_state("wt-1"));
}

#[tokio::test]
async fn a_failed_directory_watch_is_not_an_eviction_and_retries() {
    struct Flaky(Mutex<bool>);
    impl DirBackend for Flaky {
        fn watch_dir(&self, _: &Path) -> Result<(), String> {
            if *self.0.lock().unwrap() {
                Ok(())
            } else {
                Err("gone".into())
            }
        }
        fn unwatch_dir(&self, _: &Path) {}
    }
    let flaky = Arc::new(Flaky(Mutex::new(false)));
    let f = Arc::clone(&flaky);
    let w = PathWatcher::with_backend(move |_| f as Arc<dyn DirBackend>, WATCHED_DIR_LIMIT);
    let mut rx = w.subscribe();
    w.watch(&scope(), Path::new("/virt/missing/a.rs"), "1")
        .await;
    assert!(w.has_failed());
    assert!(!w.is_evicted(&scope(), Path::new("/virt/missing/a.rs")));
    assert!(rx.try_recv().is_err());
    *flaky.0.lock().unwrap() = true;
    w.retry_failed().await;
    assert!(!w.has_failed());
    assert_eq!(w.watched_dir_count(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn a_path_watched_before_and_after_its_parent_exists_unwatches_fully() {
    let tmp = tempfile::tempdir().unwrap();
    let real = tmp.path().join("real");
    fs::create_dir(&real).unwrap();
    let link = tmp.path().join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    // `link/sub` does not exist yet: the first watch is keyed by the raw spelling.
    let path = link.join("sub").join("f.md");
    let (w, fake, _tx) = fake_watcher(WATCHED_DIR_LIMIT);
    w.watch(&scope(), &path, "0001").await;
    fs::create_dir(real.join("sub")).unwrap();
    // The parent now canonicalizes to `real/sub`: a different directory key.
    w.watch(&scope(), &path, "0002").await;
    assert_eq!(w.watched_dir_count(), 1, "one registration, one dir entry");
    assert_eq!(w.registered(&scope()).len(), 1);

    w.unwatch(&scope(), &path).await;
    assert_eq!(w.watched_dir_count(), 0, "no leaked watch slot");
    assert_eq!(
        fake.watched.lock().unwrap().len(),
        fake.unwatched.lock().unwrap().len(),
        "every backend watch was released"
    );
}

/// Refuses directories under `/virt/dead` and anything in `deny_all` mode.
struct Selective {
    dead: Mutex<bool>,
    watched: Mutex<Vec<PathBuf>>,
}

impl DirBackend for Selective {
    fn watch_dir(&self, dir: &Path) -> Result<(), String> {
        if *self.dead.lock().unwrap() && dir.starts_with("/virt/dead") {
            return Err("gone".into());
        }
        self.watched.lock().unwrap().push(dir.to_path_buf());
        Ok(())
    }
    fn unwatch_dir(&self, dir: &Path) {
        self.watched.lock().unwrap().retain(|d| d != dir);
    }
}

fn selective_watcher(limit: usize) -> (PathWatcher, Arc<Selective>) {
    let b = Arc::new(Selective {
        dead: Mutex::new(true),
        watched: Mutex::default(),
    });
    let b2 = Arc::clone(&b);
    (
        PathWatcher::with_backend(move |_| b2 as Arc<dyn DirBackend>, limit),
        b,
    )
}

#[tokio::test]
async fn a_dead_dir_never_keeps_a_healthy_dir_out_of_its_slot() {
    let (w, b) = selective_watcher(2);
    let mut rx = w.subscribe();
    w.watch(&scope(), Path::new("/virt/b/f.rs"), "1").await;
    w.watch(&scope(), Path::new("/virt/c/f.rs"), "2").await;
    // The dead directory has the newest stamp, so it ranks inside the budget.
    w.watch(&scope(), Path::new("/virt/dead/f.rs"), "9").await;
    assert!(w.has_failed());
    assert_eq!(w.watched_dir_count(), 2, "healthy dirs keep their slots");
    w.retry_failed().await;
    w.retry_failed().await;
    assert_eq!(w.watched_dir_count(), 2);
    assert_eq!(b.watched.lock().unwrap().len(), 2);
    assert!(!w.is_evicted(&scope(), Path::new("/virt/b/f.rs")));
    assert!(!w.is_evicted(&scope(), Path::new("/virt/c/f.rs")));
    while let Ok(ev) = rx.try_recv() {
        assert!(
            !matches!(ev, WatchEvent::Evicted { .. }),
            "no standing eviction: {ev:?}"
        );
    }
}

#[tokio::test]
async fn a_refused_git_dir_is_not_reported_as_watched_and_retries() {
    let (w, b) = selective_watcher(WATCHED_DIR_LIMIT);
    w.watch_git_state("wt", Path::new("/virt/dead/git")).await;
    assert!(!w.watches_git_state("wt"));
    *b.dead.lock().unwrap() = false;
    w.watch_git_state("wt", Path::new("/virt/dead/git")).await;
    assert!(w.watches_git_state("wt"));
}
