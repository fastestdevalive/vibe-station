//! `resolveUseTmux` port (ports `services/resolveUseTmux.ts`).
//!
//! Coerce undefined/absent `useTmux` values to `true` for back-compat. Called
//! at manifest read time and at HTTP route handlers, ensuring every in-memory
//! session's `useTmux` is a concrete boolean before it reaches spawn/lifecycle
//! code.

/// `None` (absent) coerces to `true`; an explicit value passes through.
pub fn resolve_use_tmux(input: Option<bool>) -> bool {
    input.unwrap_or(true)
}
