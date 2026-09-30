# SDLC report: mode-changes-initial

**Date:** 2026-09-29 · **Commit:** TBD · **Sub-feature(s) covered:** mode-label-after-model-change

## Bugs

| # | Symptom | Where found | Severity |
|---|---------|-------------|----------|
| 1 | Mode label stays "Bugfix" (or whatever mode name) after user picks a different model via ModelSwitch | `StatusBar.tsx` / chat pane status bar | Low (confusing UX) |

## Root cause

- `StatusBar` → `SessionMeta.modeName` is always the literal mode name regardless of whether the model was user-overridden
- `SessionMeta` has `model` (the active model, possibly overridden) but no signal for "was this model explicitly changed away from the mode's default?"
- The daemon's `SessionRecord.model_override` tracks this but is never forwarded to `SessionMeta`

## Action items

| # | Action | Owner sub-feature | Status |
|---|--------|--------------------|--------|
| 1 | Add `model_overridden: bool` to `SessionMeta` (Rust `vst-types`) | mode-label-after-model-change | in progress |
| 2 | Populate `model_overridden` in `assemble_meta`, `get_meta`, and `read_session_meta` | mode-label-after-model-change | in progress |
| 3 | Add `modelOverridden?: boolean` to frontend `SessionMeta` type | mode-label-after-model-change | in progress |
| 4 | In `StatusBar`: when `meta.modelOverridden` is true, render mode as `"via <mode>"` instead of `<mode>` | mode-label-after-model-change | in progress |
| 5 | Add tests for new mode label behavior in `StatusBar.test.tsx` | mode-label-after-model-change | in progress |
