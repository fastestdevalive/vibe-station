# Upgrading `vst` — early ideas (pending direction, not decided)

Companion to `docs/CURL-INSTALL.md` and `docs/CLI-DAEMON-TAURI-CUJS.md`. This
is a seed doc, not a plan — written down so the follow-up planning pass
(see task tracker / next agent) starts from something instead of nothing.

## The problem

Given the install matrix already documented, a machine can end up with `vst`
present via curl, via the Tauri app's bundle, or both (in either order).
"Upgrade" has to do the right thing regardless of which of those got you
here — a single `vst update` command, one shot, no "which install method are
you" branching exposed to the user.

## Cases `vst update` needs to cover

- **curl-only** (no Tauri): re-run the equivalent of `install.sh`'s CLI
  fetch — download the new `vst-<triple>.tar.gz`, verify checksum, swap the
  binary in place (same atomic copy-then-rename `install.sh` already uses,
  since the old binary may be running as the daemon — "text file busy").
- **dmg/deb-only** (no curl, GUI installed directly): `vst update` implies
  `vst` is already reachable, which per `docs/CLI-DAEMON-TAURI-CUJS.md`'s
  CUJ 5 means the user already ran "Install CLI in PATH" at some point — so
  this is really "update the app," which should go through the platform's
  own update path where one exists (e.g. a `.deb` user might expect
  `apt upgrade`) but `vst update` should still work as a fallback: swap the
  CLI/daemon binary the same way as curl-only, and separately re-fetch the
  `.dmg`/`.AppImage`.
- **curl + dmg, either order** (the interesting one): there are now
  *two independent copies* of the merged `vst` binary — one in
  `~/.local/bin` (curl), one inside the app bundle (Tauri sidecar). Updating
  one doesn't update the other. Open question: does `vst update` need to
  update both, or just the one currently running/on `PATH`? Leaning toward
  "both, since the user shouldn't have to know two copies exist" — but this
  needs the planning pass to actually work out the mechanics (permissions to
  write inside `/Applications/vibe-station.app`, whether that requires the
  app to be closed first, etc.).
- **Daemon running while its own binary is being replaced:** the classic
  self-update problem. `install.sh`'s existing atomic
  copy-to-temp-name-then-rename trick already handles "replace a binary
  that's currently executing" for the CLI case — does the same trick cover
  replacing a binary a *long-running daemon process* is actively serving
  from, or does `vst update` need to also restart the daemon after
  swapping it in?

## `vst <path>` background version check

- On every invocation (or throttled — e.g. once per day, not every call),
  `vst` should do a cheap, non-blocking check against the daemon's `/health`
  (which already returns `version`) and/or GitHub's releases API, compare
  against its own build version, and if newer:
  - CLI: print a one-line "update available" notice, don't block the command.
  - UI (web or Tauri): surface a dismissible banner/badge — some existing
    "trigger" in the UI, exact placement TBD by the planning pass.
- Should this check ever prompt to auto-update, or always be a manual
  `vst update` action? Leaning manual-only for now (no silent
  self-modifying binaries without the user asking) — but worth the planning
  pass explicitly deciding this, not defaulting into it.

## Explicitly not decided here

- Update channels/cadence (does a beta track ever auto-offer a newer beta,
  or only stable releases?).
- Whether `vst update` needs its own confirmation prompt like
  `versionbump.sh`'s release flow has, or should just proceed (it's
  updating to a version that already went through release CI, unlike a
  release bump which is creating a brand new one).
- Rollback story if an update produces a broken binary.

This file exists so the next planning pass has a starting list of questions,
not so anyone treats it as settled.
