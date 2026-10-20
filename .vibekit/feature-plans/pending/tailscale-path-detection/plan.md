# Tailscale binary detection (macOS app / aliases / off-PATH installs)

## Problem
Daemon runs `Command::new("tailscale")` and doctor uses `which tailscale`. On macOS the
standalone/App Store Tailscale ships its CLI *inside* `Tailscale.app` and is not on PATH; users
work around it with a zsh alias, which a daemon never sees. Result: "not installed", and
the Remote Access tile's Refresh does nothing useful.

## Findings (verified on a Mac)
- `/Applications/Tailscale.app/Contents/MacOS/Tailscale status` works by absolute path.
- Symlink named `tailscale` on PATH works; invoking via absolute path of a symlink fails
  (argv0-sensitive) -> never invoke through a symlink path we construct; invoke the bundle binary directly.
- Under `env -i` the app binary fails; the daemon inherits a normal env, so fine, but keep env inherited.

## Design (one owner: `vst-lifecycle/src/tailscale_serve.rs`, new submodule `tailscale_bin.rs`)
`locate() -> Located { OnPath(PathBuf) | OffPath(PathBuf, Source) | Missing }`, resolution order:
1. executable named `tailscale` in `$PATH` dirs (own scan, no `which` subprocess).
2. well-known paths: `/Applications/Tailscale.app/Contents/MacOS/Tailscale`,
   `~/Applications/...`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/usr/sbin`, `/snap/bin`.
3. last resort (unix): login shell probe `$SHELL -ilc 'command -v tailscale'`, stdin null,
   3s timeout, kill-on-drop, parse `alias tailscale=...`/path output tolerantly, accept only if the
   resulting path exists and is executable. Result cached briefly (30s) so Refresh is cheap but a
   newly added alias is picked up.
Pure function `locate_in(path_env, home, candidates, probe)` for tests.

Consumers (all use the resolver, no more bare `"tailscale"`):
- `tailscale_serve::run_tailscale`, `routes/tailscale.rs::up`.
- `vst-daemon/doctor.rs::check_tailscale_binary`: Ok on PATH; **Warn** off-PATH with message
  "found at X but not on PATH (Remote Access works; `tailscale` isn't available in terminals)" and
  `install_hint` = fix: app-bundle -> wrapper script one-liner (`sudo tee /usr/local/bin/tailscale`
  with `exec "<bin>" "$@"`); other -> `export PATH="<dir>:$PATH"`. Paths containing `'` get no command.
- `vst-cli doctor::check_tailscale` uses the same resolver (adds vst-lifecycle dep to vst-cli).
- User-facing copy/paste commands in status (`fix_command`, `setup_command`) use shell-quoted resolved
  path when off-PATH, so they work in the user's terminal.

Wire types: unchanged (no `api/types.ts` change). UI: `not_installed` card on macOS shows the
download link (tailscale.com/download/mac) instead of the Linux `curl | sh`.

## Tests
- unit: locate_in (PATH hit, candidate hit, missing, non-executable ignored, probe parse for
  alias/path/noise), hint generation, quoting.
- doctor check test via injected locator. UI test for macOS not_installed copy.
- Verify: dev sandbox (Linux: regression, Remote Access tile still renders not_installed), plus a real
  macOS run of the daemon's status route with PATH stripped of tailscale -> expect detected, doctor Warn.

## Out of scope
Other binaries (tmux/git/agent CLIs) have the same GUI-PATH class of problem; follow-up.

---
## As built (after Opus plan + commit reviews)
- The login-shell alias probe/30s cache was dropped: `vst_agents::context::effective_path()` already
  captures the shell PATH once (warmed at daemon boot); it is consulted lazily, only when the daemon PATH
  misses. (Superseded below: aliases ARE now detected.)
- Module is `tailscale_serve/locate.rs`. Only app-bundle paths are canonicalised (argv0-sensitive); other
  hits keep their visible path (Homebrew's stable symlink, not the versioned Cellar).
- `tailscale_serve::tailscale_command()` sets `TAILSCALE_BE_CLI=1`: the macOS app binary only acts as a CLI
  when `TERM` is set, and a Finder/launchd-started daemon has none. Verified with `env -i`. Shared by the
  daemon, `up()` and `vst doctor`.
- Doctor reports an off-PATH install as `ok` (Remote Access works) with the guidance in `message`
  (the UI only renders `installHint` for non-ok checks).

## Follow-up (same PR)
- **Alias targets**: last-resort step asks the user's interactive shell `command -v tailscale`
  (`vst_agents::context::shell_command_v`, sharing `run_interactive_shell` with the PATH capture: own process
  group, 5s timeout, group kill). `parse_command_v` accepts only a single absolute executable path
  (`/p`, `alias tailscale=/p`, quoted, leading `~/`); arguments, `sudo`, expansions, functions are rejected and
  nothing is ever run through a shell. Cached: miss 10s (so Refresh stays responsive), hit while target exists.
  `locate_async()` keeps the shell spawn off the runtime; doctor locates async under its 3s budget.
- **Wire (defaulted, old payloads still parse)**: `not_installed.hostOs`, `not_connected.upCommand`.
  UI: macOS/Windows hosts get the app download instead of the Linux `curl | sh`; `tailscale up` block uses the
  daemon's command (quoted full path when off PATH).
