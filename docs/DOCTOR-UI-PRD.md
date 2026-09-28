# PRD: `vst doctor` in the UI (OOBE step 3 + Settings + status icon)

## 1. Requirements

- Add a **3rd OOBE step** ("Doctor") after the existing Location and Modes steps, shown before OOBE is marked complete. **Only for fresh installs** — users who already completed OOBE (2-step) before this ships are never retroactively re-gated; they only discover issues via the new top-bar badge/Settings panel.
  - Runs the canonical daemon-side check list (`vst-daemon/src/doctor.rs::run_doctor`): tmux, git ≥2.20, each agent CLI on PATH (claude/cursor/opencode/agy), bun, agy-acp adapter, claude-agent-acp adapter, plus diagnostic-only checks (orphan tmux sessions, orphan worktree dirs) that are informational, never required.
  - **Checks run against the daemon process's own PATH/environment, not the browser's OS or the viewing user's shell** — the daemon is what spawns agent CLIs, so its PATH is what matters. This means a shell where `claude` resolves (e.g. via a PATH entry the daemon's supervisor doesn't inherit — `~/.local/bin`, `~/.bun/bin`, nvm) can still show "not found" in Doctor; the UI must surface the resolved (or unresolved) path so this is diagnosable, not just "not found" with no context.
  - **Install commands are for the daemon's host OS only** (detected via `std::env::consts::OS` on the daemon), shown as a single command labelled "Run on `<hostname>` (Linux/macOS/Windows)" — not three OS options, since over a remote/Tailscale connection the viewing device's OS is irrelevant. If daemon host is Windows, note WSL as the likely actual install target.
  - Each check shows: name, status (OK / Warning / Missing / **Timeout**), required-vs-optional, and for anything not OK, the message + install hint (see above).
  - **Per-check timeout of 3s.** A check that hangs (e.g. `tailscale status`, a CLI `--version` doing a background update check) reports `Timeout` (a Warn-equivalent), and a timed-out check can never itself count as a blocking required failure — it degrades to "couldn't verify," not "broken."
  - **Blocking vs non-blocking, in two tiers:**
    - **Hard-required (no bypass):** tmux, git, "daemon reachable". Nothing in vibe-station functions without these — Continue stays disabled with no override, and no "Continue anyway" is offered, until they pass.
    - **Soft-required (bypassable):** the "at least one of claude/cursor/opencode/agy" rule. This one is a detection heuristic that can be legitimately wrong for an advanced/nonstandard setup (e.g. a CLI installed somewhere doctor's PATH/env resolution doesn't see), so it's the only failure "Continue anyway" can override.
    - Both tiers are evaluated daemon-side into two fields on the response — `hard_ok: bool` and `ok: bool` (true only if `hard_ok` AND the soft/CLI rule passes) — and both the OOBE gate and the top-bar badge read these same two fields so they can never disagree with each other or with the escape hatch's own logic.
  - **Escape hatch:** only surfaces when `hard_ok` is true but `ok` is false (i.e. only the CLI rule is failing). A small "Continue anyway" link below the still-disabled Continue button, behind a one-line confirm ("You have no agent CLI installed — most of vibe-station won't work until you install one. Continue anyway?"). Never shown while `hard_ok` is false.
  - **Daemon-unreachable state is distinct from a failing check** — since a down daemon can't serve `GET /api/doctor` at all, the client synthesizes this state itself from the fetch failure (shown as "Can't reach daemon" rather than a doctor check row), and the top-bar icon gets its own "disconnected" visual, separate from the attention badge.
  - **Re-check button:** disabled (with a spinner) while a check run is in flight; a second click while one is running is a no-op (single-flight on the client). Stale in-flight responses are dropped if a newer request has since started or completed. A "last checked Xs ago" line is shown next to the button.
- Add a **"Doctor" entry in Settings** (new `DoctorSetting.tsx`, registered in `SettingsPanel.tsx`'s `sections` array), reachable at `/settings/doctor`, showing the same check list, re-check button, and last-checked timestamp. On mobile, this panel stacks like other settings sections (list → detail), no special-casing needed.
- Add a **Doctor icon button** in `TopBar.tsx`, immediately to the left of the existing "Keyboard shortcuts" button, following the same `icon-btn` pattern. On narrow/mobile widths where the shortcuts+settings icons already collapse into a menu, Doctor collapses into that same menu rather than getting special treatment.
  - Default state: neutral/muted icon (e.g. `Stethoscope`), `aria-label`/tooltip "Doctor — all checks passing".
  - Attention state: small badge overlay (new CSS — no existing icon-badge component to reuse) showing `!`, driven by the same daemon-computed `ok` field described above (so badge and OOBE gate use identical logic). `aria-label` includes the count, e.g. "Doctor — 2 required issues found", read by screen readers (not just a visual dot).
  - Disconnected state: distinct muted/greyed icon when the daemon itself is unreachable (see above), not the same as the attention badge.
  - Clicking navigates to `/settings/doctor`.
  - Poll cadence: re-run on daemon (re)connect and every 5 minutes while the tab is visible; **paused while the tab is hidden** (`document.visibilityState`), resumed (with an immediate check) on becoming visible again, to avoid polling into a backgrounded/closed laptop lid.
- **`cloudflared` check must mirror the desktop app's own resolution order, not a bare PATH lookup**: check `VST_CLOUDFLARED_BIN` (set by the Tauri shell to the bundled sidecar binary — `desktop/src-tauri/src/main.rs:27-40`) first, then fall back to `cloudflared` on PATH. When running as the packaged desktop app the bundled sidecar is always present, so this check reports `Ok` with status text "bundled" and shows **no install hint** — it's only a real "Missing" (with an install hint) for non-desktop daemon runs (headless/server install, dev sandbox) where no sidecar exists and PATH is the only source. Same reasoning applies to `tailscale`, which is never bundled and is always a plain PATH/binary check. Both are optional/diagnostic, never required.
- Install commands are **not translated / not localized** — shown verbatim in English regardless of UI locale, matching `vst doctor`'s CLI output.
- Accessibility: status glyphs (✓/✗/⚠/—) always pair with a text status label, never glyph-only; each install command row has a copy-to-clipboard button.
- Doctor results are computed **daemon-side only** — the frontend never re-derives status. `vst-daemon`'s `run_doctor` is the single source of truth consumed by both `vst doctor` (CLI) and the new API; the CLI and daemon module are refactored to share one install-hint data table (see §3) so they cannot silently diverge.

### Out of scope
- Auto-installing missing dependencies (we only ever show the command, never run installers for the user without explicit confirmation).
- Any notion of "the viewing device's OS" — Doctor is always about the daemon's host machine.
- Localizing install commands.

## 2. ASCII UI

### 2a. OOBE — Step 3 of 3 (Doctor)

```
┌──────────────────────────────────────────────────────────┐
│  Step 3 of 3                                    [ Back ]  │
│                                                             │
│  System Check           Checked on: my-linux-host (Linux)  │
│  Last checked 4s ago                                        │
│                                                             │
│   ✓ OK       tmux              2.4               required   │
│   ✓ OK       git                2.39             required   │
│   ✗ Missing  Claude Code CLI    not found         1 of 4     │
│         Run on my-linux-host (Linux):                       │
│         curl -fsSL claude.ai/install.sh | sh      [Copy]    │
│   ✓ OK       Cursor CLI         1.2.0             1 of 4     │
│   —  Missing OpenCode           not found          1 of 4     │
│   —  Missing agy                not found          1 of 4     │
│   ⚠ Timeout  bun                no response (3s)   optional  │
│   ✓ OK       Daemon reachable   —                  required   │
│                                                             │
│  [ Re-check ]                                               │
│                                                             │
│                      [ Continue → ]  (disabled — install a │
│                       CLI above, or bypass below)            │
│                       Continue anyway ›  (shown only because │
│                       tmux/git/daemon are all OK — no bypass │
│                       exists if any of those three fail)     │
└──────────────────────────────────────────────────────────┘
```

### 2b. Settings → Doctor panel

```
┌───────────────┬──────────────────────────────────────────┐
│  Skills        │  Doctor                                  │
│  Modes         │  Checked on: my-linux-host (Linux)        │
│  LSP           │  Last checked 4s ago         [Re-check]  │
│ ▸Doctor        │  ✗ 1 required issue found                 │
│  About         │                                            │
│                │  Required                                 │
│                │   ✓ OK  tmux            2.4                │
│                │   ✓ OK  git             2.39               │
│                │   ✓ OK  Daemon reachable                   │
│                │                                            │
│                │  Agent CLIs (need at least one)            │
│                │   ✓ OK       Cursor CLI      1.2.0          │
│                │   ✗ Missing  Claude Code     not found      │
│                │        Run on my-linux-host (Linux):        │
│                │        curl -fsSL claude.ai/install.sh|sh  │
│                │                                     [Copy] │
│                │   —  Missing  OpenCode      not found       │
│                │   —  Missing  agy           not found       │
│                │                                            │
│                │  Optional / diagnostic                     │
│                │   ⚠ Timeout  bun            no response      │
│                │   ✓ OK       cloudflared    bundled           │
│                │   —  Missing tailscale      not found          │
│                │   —  info    0 orphan tmux sessions          │
│                │   —  info    0 orphan worktree dirs           │
└───────────────┴──────────────────────────────────────────┘
```

### 2c. Top bar icon states

```
Neutral (ok=true):     Attention (ok=false, required/CLI     Disconnected (daemon
                        rule failing):                        unreachable):
┌──────┐ ┌──────┐      ┌──────┐ ┌──────┐                     ┌──────┐ ┌──────┐
│  🩺  │ │ ⌨️   │      │ 🩺 ❗│ │ ⌨️   │                     │ 🩺⚪ │ │ ⌨️   │
└──────┘ └──────┘      └──────┘ └──────┘                     └──────┘ └──────┘
aria-label: "Doctor —   aria-label: "Doctor — 2               aria-label: "Doctor —
all checks passing"     required issues found"                 can't reach daemon"
```

## 3. New APIs / DB changes

### REST

- **`GET /api/doctor`** — runs `vst-daemon/src/doctor.rs::run_doctor` (extended per below) and returns the full check list. New type in `vst-types/src/rest/doctor.rs`, parallel to `Health`:
  ```rust
  pub struct DoctorReport {
      pub hard_ok: bool,               // tmux + git + daemon-reachable all Ok — no bypass possible
      pub ok: bool,                    // hard_ok AND >=1 agent CLI Ok — false alone is bypassable
      pub host_os: String,             // "linux" | "macos" | "windows" — daemon's own OS
      pub hostname: String,
      pub checked_at: String,          // RFC3339, for "last checked Xs ago"
      pub checks: Vec<DoctorCheckDto>,
  }
  pub struct DoctorCheckDto {
      pub name: String,
      pub status: DoctorStatus,        // Ok | Warn | Error | Timeout (NEW variant)
      pub required: bool,              // NEW: individually required
      pub group: CheckGroup,           // NEW: Required | AgentCli | Optional | Diagnostic
      pub message: String,
      pub resolved_path: Option<String>,  // NEW: where it was found, if found
      pub install_hint: Option<String>,   // NEW: single command for host_os, already resolved server-side
  }
  ```
  No request body. Each subprocess check runs with a 3s timeout (e.g. `tokio::time::timeout`); a timed-out check reports `DoctorStatus::Timeout` and never contributes to blocking `ok`.
- No `doctorAcknowledged` / OOBE-state extension needed — checks always re-run live and upgrading users are never re-gated (see §1), so `/api/oobe/state` does not need a doctor-related field. It does, however, need a real **step 2 persisted flag**: today `vst-routes/src/oobe.rs` derives `currentStep` from a single `step1_confirmed` boolean and never persists step 2 at all. Adding step 3 requires:
  - A new `step2_confirmed: bool` field in the same OOBE state file/record.
  - A new `POST /api/oobe/step2` (mirroring the existing step-1 confirm endpoint) that sets it and advances `currentStep` to 3.
  - `currentStep`'s type/response widens from effectively `1 | 2` to `1 | 2 | 3`, and `completed` is only set true after step 3 (Continue or "Continue anyway").

### WS

- None required for v1 — checks are synchronous-with-timeout (worst case ~3s per hung check) and run on-demand (button click, visibility-triggered poll), not continuously. No push channel needed.

### DB / persisted state

- No new SQLite table — doctor results are always computed live, never stored.
- **Install-hint strings move out of `vst-cli/src/commands/doctor.rs`'s inline `print_hint()`/OS-branch code (currently ~lines 146-148, 312-323)** into a small shared table in **`vst-types`** (e.g. `vst-types/src/doctor_hints.rs`), keyed by check name + OS, consumed by both `vst-cli` (`vst doctor`) and `vst-daemon` (`GET /api/doctor`) so the two surfaces can't drift out of parity.
- `run_doctor` gains: per-check timeout wrapping, the `group`/`required` classification, `resolved_path` capture, and the at-least-one-CLI aggregate rule folded into `DoctorReport.ok`. The existing orphan-sessions/orphan-worktree checks are reclassified as `CheckGroup::Diagnostic` (informational, never blocking) rather than left ambiguous.
- **`cloudflared`'s check resolves the same way the desktop app itself does**: read `VST_CLOUDFLARED_BIN` if set (the Tauri-injected path to the bundled sidecar, `desktop/src-tauri/src/main.rs:27-40`), else fall back to `cloudflared` on PATH. If resolved via `VST_CLOUDFLARED_BIN`, `resolved_path` is populated and `message` reads `"bundled"` with no install hint — this is the common case for anyone running the packaged desktop app. A bare "not found" with an install hint only applies when neither the env var nor PATH resolves anything, i.e. a non-desktop daemon run (headless/server install, dev sandbox). `tailscale` has no bundled/sidecar path in any run mode and is always a plain PATH lookup.
- OOBE's `currentStep: 1 | 2` type (`useOobeGate.ts:7`, `OobeFlow.tsx:12,16`) widens to `1 | 2 | 3`, `TOTAL_STEPS` bumps to 3, and the step-2 persistence gap above is fixed as part of this work (not a pre-existing guarantee to rely on).
