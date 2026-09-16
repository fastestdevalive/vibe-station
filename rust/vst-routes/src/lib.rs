#![forbid(unsafe_code)]

//! vst-routes — daemon REST route handlers (arch `07a-rest-routes-core`).
//!
//! This crate ports the `daemon/src/routes/*.ts` route logic. Part 07a is
//! dispatched in continuations; dispatch #1 (this slice) ports `sessions.ts`
//! Group A. HTTP/axum wiring lives in part 08; this crate exposes handler
//! bodies as testable functions on [`sessions::SessionRoutes`].

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
