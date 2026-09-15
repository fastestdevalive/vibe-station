//! Behavior contract for `resolveUseTmux.ts` (part 02-process-pty).
//! Ported 1:1 from `daemon/src/__tests__/resolveUseTmux.test.ts`:
//! coerce undefined/absent `useTmux` values to `true` for back-compat.

use vst_proc::resolve_use_tmux;

#[test]
fn undefined_defaults_to_true() {
    assert!(resolve_use_tmux(None));
}

#[test]
fn true_stays_true() {
    assert!(resolve_use_tmux(Some(true)));
}

#[test]
fn false_stays_false() {
    assert!(!resolve_use_tmux(Some(false)));
}
