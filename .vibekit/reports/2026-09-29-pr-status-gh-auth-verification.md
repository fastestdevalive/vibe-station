# pr-status-gh-auth — Verification Report

**Date:** 2026-09-29
**Branch:** pr-status-ux-plan
**Phases verified:** 1 (Rust types/store), 2 (credential chain + Doctor), 3 (TS/React UI), 4 (sandbox)

## Summary

- Feature adds `PrErrorKind` + `featureOk` to the two-axis PR status model
- Doctor now has a Feature group with `github-cli` and `github-auth` checks
- VCS panel shows inline error row when credentials are missing
- Bottom-bar dot fires on Feature-group errors (no credentials → red dot)

## Test results

- Rust: `cargo test -p vst-store -p vst-lifecycle -p vst-types` — PASSED
- TypeScript: `npx vitest run StatusDot DashboardPanel DoctorCheckList VcsPanel statusColor` — 78 tests PASSED

## Bugs found during Phase 4

| # | Bug | Fix |
|---|-----|-----|
| 1 | `DoctorCheckList.tsx` — Feature group checks were filtered but never rendered (missing JSX block) | Added `{feature.length > 0 && (...)}` rendering block |
| 2 | `ToolPanel.tsx` — `useServerStore` not imported (used at line 165) | Added `import { useServerStore } from "@/hooks/useServerStore"` |
| 3 | `ToolPanel.tsx` — `worktreePrStatus` not imported (used at line 171) | Added `import { worktreePrStatus } from "@/lib/statusColor"` |
| 4 | `dev-entrypoint.sh` — unclosed `if` block at line 33 (outer `if` for cursor-agent-versions never closed) | Added missing `fi` after inner `fi` |

## Screenshots

### Doctor — no credentials
![Doctor no credentials](screenshots/pr-status-gh-auth/doctor-no-credentials.png)

### Bottom-bar red dot
![Bottom bar red dot](screenshots/pr-status-gh-auth/bottom-bar-red-dot.png)

### VCS panel error row
![VCS panel no credentials](screenshots/pr-status-gh-auth/vcs-panel-no-credentials.png)

### Doctor — env token active
![Doctor env token](screenshots/pr-status-gh-auth/doctor-env-token.png)

## Root cause fixed

`row_to_session` in `vst-store/src/row_mappers.rs` hardcoded `error: None` — the PR poller
wrote errors to the DB but they were silently dropped on every read, causing a rewrite storm
(all 74 sessions every 30s). Fixed by reading `prError`/`prErrorKind` columns properly.

## Action items

- None — feature complete and verified
