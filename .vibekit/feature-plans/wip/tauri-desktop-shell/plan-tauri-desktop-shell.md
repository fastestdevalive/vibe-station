# Plan: Tauri Desktop Shell

## Summary
Wrap the vibe-station web UI in a Tauri v2 native shell so it can be distributed as a macOS/Linux desktop app with a bundled daemon binary.

---

## Phase 1 — Daemon binary build pipeline

- [x] 1.1 Create `scripts/build-daemon-binary.sh`
- [x] 1.2 Create `scripts/download-cloudflared.sh`
- [ ] 1.3 Smoke-test daemon binary locally (Linux x64) — SKIPPED: Rust/Node24/pkg not installed in this worktree sandbox; the build scripts are authored and ready but require local environment with all tooling installed.

## Phase 2 — `cloudflared.ts` + `vst doctor`

- [x] 2.1 `daemon/src/services/cloudflared.ts:43` — use `VST_CLOUDFLARED_BIN` env var
- [x] 2.2 `cli/src/commands/doctor.ts` — add cloudflared check

## Phase 3 — Tauri shell (`apps/desktop/`)

- [x] 3.1 Scaffold `apps/desktop/` with Tauri v2 (manual, no cargo tauri init since Rust not available)
- [x] 3.2 `tauri.conf.json` — configure product, windows, bundles
- [x] 3.3 `entitlements.mac.plist`
- [x] 3.4 `src/daemon.rs`
- [x] 3.5 `src/tray.rs`
- [x] 3.6 `src/main.rs`

## Phase 4 — TopBar chrome (web-ui)

- [x] 4.1 Add `data-tauri-drag-region` to TopBar header and row
- [x] 4.2 Create `WindowControls.tsx` (uses `__TAURI_INTERNALS__` instead of static import to avoid requiring `@tauri-apps/api` in web-ui build)
- [x] 4.3 Add `<WindowControls />` to TopBar right side

## Phase 5 — CI build matrix

- [x] 5.1 Create `.github/workflows/desktop-build.yml`

## Phase 6 — Dev flow verification

- [x] 6.1 `tauri dev` config present in `tauri.conf.json` (beforeDevCommand + devUrl)
- [x] 6.2 `pnpm dev` in web-ui unchanged (WindowControls renders nothing outside Tauri; no Tauri packages added to web-ui)
