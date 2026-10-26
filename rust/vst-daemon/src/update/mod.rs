//! App auto-update (`vst update`, update chip, restart + rollback).
//!
//! A module inside `vst-daemon`, not a new crate: `vst-cli`
//! already depends on `vst-daemon`, so the daemon-less CLI fallback calls
//! `vst_daemon::update::*` directly. Wire types live in `vst-types`; the
//! `HandoffAuth` payload lives in `vst-routes` next to `AuthState`.
//!
//! See docs/UPDATE.md.

// Crate-internal.
pub(crate) mod detect;
pub(crate) mod exec;
pub(crate) mod github;
pub(crate) mod http;
pub(crate) mod impact;
pub(crate) mod paths;
pub(crate) mod routes;
pub(crate) mod timing;

// `pub` only because integration tests (`vst-daemon/tests`, `vst-cli/tests`)
// read them; other crates go through the facade below.
#[doc(hidden)]
pub mod handoff;
#[doc(hidden)]
pub mod install;
#[doc(hidden)]
pub mod state;

pub mod platform;
pub mod restart;
pub mod service;
pub mod version;
pub mod watch;

// The surface `vst-cli` uses.
pub use install::cancel::CancelToken;
pub use paths::{try_update_lock, vst_home};
pub use platform::{assets_for, platform_key};
pub use service::{api_base_from_env, UpdateConfig, UpdateService};
pub use timing::UI_CLI_RESTART_WAIT;
pub use version::parse as parse_version;
pub use watch::{run_watch, WatchArgs};
