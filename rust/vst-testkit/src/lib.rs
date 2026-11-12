#![forbid(unsafe_code)]
//! `vst-testkit` — shared test fixtures/helpers, dev-dep only.
//!
//! Ported from the TS `gitFixture.ts` and `daemon/src/__tests__/fixtures/*` so
//! no later part reinvents them. Crate body grows as later parts add fixture
//! builders; this is the part-00 foundation.

pub mod git_fixture;
pub mod proc_guard;

pub use git_fixture::{create_git_fixture, remove_git_fixture, GitFixture};
pub use proc_guard::{
    group_alive, native_daemon_tests_enabled, pid_alive, terminate_group, ChildGuard,
    DaemonHomeGuard, NATIVE_DAEMON_TESTS_ENV,
};
