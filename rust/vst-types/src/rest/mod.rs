//! REST request/response wire shapes — mirrors every `daemon/src/routes/*.ts`
//! zod schema and handler response literal. One submodule per route file.
//!
//! **Ownership rule:** `vst-routes` and `vst-cli` are forbidden from defining
//! their own `#[derive(Serialize, Deserialize)]` shapes — they use these, or
//! follow the `vst-types` amendment rule (addition-only + a wire-fixture
//! update). See arch doc § API Contracts.

pub mod attachments;
pub mod auth;
pub mod fs;
pub mod health;
pub mod mobile_auth;
pub mod modes;
pub mod open;
pub mod ordered_lists;
pub mod projects;
pub mod sessions;
pub mod settings;
pub mod skills;
pub mod tailscale;
pub mod worktrees;

pub mod shared;

pub use shared::*;
