#![forbid(unsafe_code)]

//! vst-git — git / worktree / project services (daemon-rust-port part 03).
//!
//! Ports the part-03 `daemon/src/services/*` git files (see the daemon-rust-port
//! file-map):
//! - `git.ts`            → [`git`] (low-level git plumbing + a `GitService`
//!   handle for `fetchOrigin`'s in-flight dedupe / cooldown state)
//! - `worktreeService.ts`→ [`worktree_service`]
//! - `branchValidator.ts`→ [`branch_validator`]
//! - `projectSetup.ts`   → [`project_setup`]
//! - `naming.ts`         → [`naming`]
//! - `slugify.ts`        → [`slugify`]
//! - `prefix.ts`         → [`prefix`]
//! - `recover.ts`        → [`recover`]
//! - `rollback.ts`       → [`rollback`]
//! - `sessionId.ts`      → [`session_id`]
//!
//! Git is invoked as one-shot `tokio::process::Command` requests (request /
//! response, capturing stdout), NOT via `vst-proc`'s `PtyHandle` — a git
//! plumbing call has no interactive input and needs no ring buffer. The
//! `vst-proc`/`vst-store` dependencies exist only for `recover.ts`/`rollback.ts`
//! (tmux session liveness + kill, and the persisted project/session registries).
//!
//! [`paths`] holds the `~/.vibe-station` path derivation that `paths.ts`
//! (part 00, not yet ported into a shared crate) provides in the TS tree — the
//! subset `recover`/`rollback`/`worktree_service`/`session_id` need, defined
//! here locally so this crate does not reach outside its own module.

pub mod branch_validator;
pub mod direct_pty;
pub mod git;
pub mod naming;
pub mod paths;
pub mod prefix;
pub mod project_setup;
pub mod recover;
pub mod rollback;
pub mod session_id;
pub mod slugify;
pub mod worktree_service;

pub use branch_validator::{branch_exists_in_repo, validate_branch, ValidationResult};
pub use direct_pty::DirectPtyRegistry;
pub use git::GitService;
pub use paths::Paths;
pub use prefix::{generate_project_prefix, make_unique_prefix};
pub use recover::{recover_not_started_sessions, SessionLiveness};
pub use rollback::rollback_worktree_create;
pub use session_id::{generate_session_id, reserve_next_worktree_num, tmux_name_for_session};
pub use slugify::{is_safe_project_id, slugify};
pub use worktree_service::{create_worktree_record, resolve_branch_for_create};
