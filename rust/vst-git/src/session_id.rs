//! Ports `sessionId.ts` — worktree number reservation + session id generation.
//!
//! A session `id` is generated independently of any position/type-count, so a
//! respawned session can never collide with the row it replaced.

use vst_types::{ProjectRecord, SessionType, WorktreeRecord};

/// Extract the trailing `-<num>` from a worktree id (e.g. `vs-3` -> 3).
/// Returns `None` when the trailing segment isn't numeric (or id is malformed).
fn num_of(wt: &WorktreeRecord) -> Option<i64> {
    let last = wt.id.rsplit('-').next()?;
    last.parse::<i64>().ok()
}

/// Reserve the next worktree number for a project — monotonic, never reused.
///
/// Uses the persisted high-water counter `project.nextWorktreeNum`. For legacy
/// manifests without it, seeds from `max(existing worktree nums) + 1` (the
/// non-numeric-suffix filter prevents a `NaN` poisoning the counter).
///
/// `dir_exists` lets the caller check for stray on-disk worktree directories
/// left by non-purge deletes; the counter is bumped by the caller (via
/// `mutate_project`) as part of the same atomic update.
pub fn reserve_next_worktree_num(
    project: &ProjectRecord,
    dir_exists: &dyn Fn(&str) -> bool,
) -> i64 {
    let max_num = project
        .worktrees
        .iter()
        .filter_map(num_of)
        .max()
        .unwrap_or(0);
    let seed = max_num + 1;
    let mut n = project.next_worktree_num.unwrap_or(seed);
    // Paranoia guard: never land on a stray on-disk dir (old non-purge orphans)
    // OR an id that's already a live worktree record. `next_worktree_num` is a
    // persisted high-water counter that can drift below the actual max (seed
    // data, manual DB edits, or any bug in whatever last bumped it) — when it
    // does, checking only the filesystem still reuses an existing worktree's
    // id and the insert fails on the `worktrees.id` UNIQUE constraint.
    while dir_exists(&format!("{}-{}", project.prefix, n))
        || project
            .worktrees
            .iter()
            .any(|w| w.id == format!("{}-{}", project.prefix, n))
    {
        n += 1;
    }
    n
}

/// Generate an independently-unique session id. `scope_id` is the worktree id
/// (worktree-scoped) or project id (direct) — kept as a prefix purely so ids
/// stay greppable, NOT for uniqueness.
pub fn generate_session_id(scope_id: &str, r#type: SessionType) -> String {
    let mut buf = [0u8; 4];
    // Best-effort randomness; a failure here is a programmer-error condition.
    let _ = getrandom::fill(&mut buf);
    let hex: String = buf.iter().map(|b| format!("{b:02x}")).collect();
    let letter = match r#type {
        SessionType::Agent => 'a',
        SessionType::Terminal => 't',
    };
    format!("{scope_id}-{letter}-{hex}")
}

/// Canonical tmux session name for a NEW session — derived from its id.
pub fn tmux_name_for_session(id: &str) -> String {
    format!("vst-{id}")
}
