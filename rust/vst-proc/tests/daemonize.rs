//! Integration tests for `spawn_detached` (`cli-daemon-unification` Part 03,
//! CUJ1-fallback/CUJ2b's headless daemon spawn). Real process spawns — no
//! mocking, since detachment (`setsid`, fd redirection) is exactly the thing
//! under test.

use std::collections::HashMap;
use std::time::Duration;

use vst_proc::spawn_detached;

#[tokio::test]
async fn spawned_process_survives_after_the_spawning_scope_ends() {
    let tmp = tempfile::tempdir().unwrap();
    let log_path = tmp.path().join("out.log");
    let marker_path = tmp.path().join("marker");

    // A shell loop that keeps running (touching a marker file each second)
    // well past this test function's own scope — proves detachment, not
    // just "child process is alive while the parent async task is still
    // executing" (which would be true even for a non-detached child).
    {
        let exe = std::path::PathBuf::from("/bin/sh");
        let args = [
            "-c",
            &format!(
                "for i in 1 2 3 4 5 6 7 8; do touch {}; sleep 1; done",
                marker_path.display()
            ),
        ];
        spawn_detached(&exe, &args, tmp.path(), &HashMap::new(), &log_path)
            .expect("spawn_detached should succeed");
    }
    // `spawn_detached`'s own scope (and its `Command`/`Child` value) has now
    // fully dropped -- if the child weren't truly detached (e.g. still tied
    // to a pipe or session this test process controls), dropping our side
    // could plausibly affect it. Wait past the point a naively-attached
    // child would have been reaped/killed, then confirm the marker file is
    // still being updated.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let mtime_1 = std::fs::metadata(&marker_path)
        .expect("marker file should exist")
        .modified()
        .unwrap();

    tokio::time::sleep(Duration::from_millis(2000)).await;
    let mtime_2 = std::fs::metadata(&marker_path)
        .expect("marker file should still exist")
        .modified()
        .unwrap();

    assert!(
        mtime_2 > mtime_1,
        "marker file should keep being touched by the still-alive detached process"
    );
}

#[tokio::test]
async fn spawned_process_environment_excludes_stripped_vars() {
    let tmp = tempfile::tempdir().unwrap();
    let log_path = tmp.path().join("env.log");

    // Only ONE var in the env map -- `env_clear()` + `.envs(env)` inside
    // spawn_detached means the child sees ONLY what's in this map, nothing
    // inherited from this test process's own environment (which is exactly
    // the property a self-heal caller relies on to strip agent-scoped vars
    // like VST_SESSION before spawning a fresh daemon).
    let mut env = HashMap::new();
    env.insert("KEPT_VAR".to_string(), "yes".to_string());

    let exe = std::path::PathBuf::from("/usr/bin/env");
    spawn_detached(&exe, &[], tmp.path(), &env, &log_path).expect("spawn_detached should succeed");

    // Give the short-lived `env` process time to run and exit; its stdout
    // (redirected to log_path) is the full list of env vars it saw.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let output = std::fs::read_to_string(&log_path).expect("log file should exist");

    assert!(
        output.contains("KEPT_VAR=yes"),
        "the one var explicitly passed should be present: {output}"
    );
    assert!(
        !output.contains("VST_SESSION"),
        "a var never passed in the env map must not leak in from this test process's own \
         environment: {output}"
    );
    assert!(
        !output.contains("CARGO_"),
        "cargo's own build-time env vars (always present in this test process) must not leak \
         through env_clear(): {output}"
    );
}
