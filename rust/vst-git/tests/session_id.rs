//! Behavior contract for `sessionId.ts` (part 03-git-worktree).
//! Ported from `daemon/src/__tests__/sessionId.test.ts` (reserve + generate +
//! tmux-name halves).

use std::collections::HashSet;

use tempfile::tempdir;
use vst_git::paths::Paths;
use vst_git::session_id::{generate_session_id, reserve_next_worktree_num, tmux_name_for_session};
use vst_types::{ProjectRecord, SessionType, WorktreeRecord};

fn make_worktree(id: &str) -> WorktreeRecord {
    WorktreeRecord {
        id: id.into(),
        name: None,
        branch: format!("branch-{id}"),
        branch_is_placeholder: None,
        base_branch: "main".into(),
        base_sha: "0".repeat(40),
        created_at: "2024-01-01T00:00:00.000Z".into(),
        pinned_at: None,
        hidden_at: None,
        sort_order: 0.0,
        terminal_seq: Some(0),
        agent_seq: Some(0),
        lsp_enabled: None,
        sessions: vec![],
        open_files: vec![],
    }
}

fn make_project(worktrees: Vec<WorktreeRecord>, next: Option<i64>) -> ProjectRecord {
    ProjectRecord {
        id: "proj-1".into(),
        absolute_path: "/fake/proj-1".into(),
        prefix: "vs".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2024-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: None,
        worktrees,
        next_worktree_num: next,
        lsp_enabled: None,
        open_files: vec![],
    }
}

/// Build a `dir_exists` predicate backed by a real temp worktrees directory.
fn dir_check(paths: &Paths) -> impl Fn(&str) -> bool + '_ {
    move |wt_id| paths.worktree_path("proj-1", wt_id).exists()
}

#[test]
fn delete_highest_then_create_yields_n_plus_1_not_the_freed_number() {
    let project = make_project(vec![make_worktree("vs-1"), make_worktree("vs-2")], Some(4));
    let n = reserve_next_worktree_num(&project, &|_| false);
    assert_eq!(n, 4);
}

#[test]
fn legacy_manifest_seeds_from_existing_worktrees() {
    let project = make_project(
        vec![
            make_worktree("vs-1"),
            make_worktree("vs-3"),
            make_worktree("vs-2"),
        ],
        None,
    );
    assert_eq!(reserve_next_worktree_num(&project, &|_| false), 4);
}

#[test]
fn legacy_manifest_with_non_numeric_suffixed_worktree_does_not_yield_nan() {
    let project = make_project(
        vec![make_worktree("vs-1"), make_worktree("vs-feature")],
        None,
    );
    let n = reserve_next_worktree_num(&project, &|_| false);
    assert_eq!(n, 2);
}

#[test]
fn empty_legacy_manifest_seeds_at_1() {
    let project = make_project(vec![], None);
    assert_eq!(reserve_next_worktree_num(&project, &|_| false), 1);
}

#[test]
fn skips_a_stray_on_disk_directory_left_by_a_non_purge_delete() {
    let tmp = tempdir().unwrap();
    let paths = Paths::with_home(tmp.path().to_path_buf());
    std::fs::create_dir_all(paths.worktree_path("proj-1", "vs-4")).unwrap();

    let project = make_project(vec![make_worktree("vs-1")], Some(4));
    assert_eq!(reserve_next_worktree_num(&project, &dir_check(&paths)), 5);
}

#[test]
fn skips_a_persisted_counter_that_drifted_onto_an_existing_worktree() {
    // `next_worktree_num` is a high-water counter that can drift below the
    // actual max (stale seed data, manual DB edits, or any bug in whatever
    // last bumped it). Reproduces the UNIQUE-constraint failure a stale
    // counter causes: worktrees vs-1..vs-4 exist, but the counter says 4.
    let project = make_project(
        vec![
            make_worktree("vs-1"),
            make_worktree("vs-2"),
            make_worktree("vs-3"),
            make_worktree("vs-4"),
        ],
        Some(4),
    );
    assert_eq!(reserve_next_worktree_num(&project, &|_| false), 5);
}

#[test]
fn generates_distinct_ids_across_calls_for_same_scope_and_type() {
    let mut ids = HashSet::new();
    for _ in 0..50 {
        ids.insert(generate_session_id("vs-1", SessionType::Agent));
    }
    assert_eq!(ids.len(), 50);
}

#[test]
fn prefixes_the_id_with_scope_id_and_a_type_letter_marker() {
    let agent = generate_session_id("vs-1", SessionType::Agent);
    assert!(is_hex_suffixed(&agent, "vs-1-a-"));
    let terminal = generate_session_id("proj-1", SessionType::Terminal);
    assert!(is_hex_suffixed(&terminal, "proj-1-t-"));
}

fn is_hex_suffixed(id: &str, prefix: &str) -> bool {
    let Some(rest) = id.strip_prefix(prefix) else {
        return false;
    };
    rest.len() == 8 && rest.chars().all(|c| c.is_ascii_hexdigit())
}

#[test]
fn tmux_name_for_session_derives_deterministically_from_the_id() {
    assert_eq!(
        tmux_name_for_session("vs-1-a-deadbeef"),
        "vst-vs-1-a-deadbeef"
    );
}

#[test]
fn a_reset_style_replacement_id_never_collides_with_the_id_it_replaces() {
    let original = generate_session_id("vs-1", SessionType::Agent);
    let replacement = generate_session_id("vs-1", SessionType::Agent);
    assert_ne!(replacement, original);
}
