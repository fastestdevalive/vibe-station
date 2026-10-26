# Updates and releases

## What it does

- The daemon checks GitHub releases for a newer version (first check 60 s after boot, then every 3 days). Forced checks are limited to one GitHub call per 30 s.
- The web UI shows an **update chip** in the top bar. It opens a dialog (changelog, install, skip, remind me later). **Settings > Updates** shows the same state and has "Check for updates" and the auto-check toggle.
- CLI: `vst update` (check, confirm, install), `--check` (exit 0 up to date, 10 update available, 1 error), `--yes` (no prompt), `--skip <ver>` / `--unskip <ver>`, and `vst daemon restart`.
- **Restart handshake:** the old daemon writes `restart-handoff.json` (signing key, revocations, signed-in devices, port) to the vst home. The new daemon reads it, so logins survive a planned restart. The UI shows a restarting overlay and reloads when `/health` reports a new `bootId`.
- **Rollback:** before a headless restart a watcher (`vst daemon _restart-watch`, run from the saved `.vst.prev` binary) waits for the new daemon. If none answers `/health` within 30 s, it restores the previous binaries and the saved store snapshot. The UI and `vst update --check` then report the rolled-back version.
- A Tauri-hosted daemon is never restarted in place: the user quits and relaunches the app. Mobile tokens are read-only.

## Knobs

| Knob | Effect |
|------|--------|
| `VST_UPDATE_CHECK=0` | Disables automatic checks (manual checks still work). Overrides the setting. |
| `VST_UPDATE_API_BASE` | Replaces the GitHub API base URL (tests, mirrors). |
| `autoCheck` | Auto-check toggle in `update-state.json` (default on); Settings > Updates. |
| Interval | 3 days between automatic checks (`DEFAULT_CHECK_INTERVAL` in `update/service/mod.rs`). |
| Files in `~/.vibe-station/` | `update-state.json` (last check, etag, skipped versions, pending restart, rollback), `.update.lock` (one install at a time), `restart-handoff.json` (short-lived). |

## Install methods

- `curl` (`install.sh`, default `~/.local/bin`): automatic. Every binary in the tarball is replaced.
- `curl-appimage` / `appimage` (Linux desktop): automatic. The AppImage is replaced.
- `dmg` (macOS app): manual. The UI shows steps, because the browser download keeps quarantine.
- `deb` (Linux package): manual, with the same steps flow.
- With several copies, one install updates all automatic ones and lists manual steps for the rest. A platform with no release asset gets only a "View release" link.
- Each replaced file is first kept as `.<name>.prev` next to it, for rollback and manual recovery.

## Verification

- Each release publishes `SHA256SUMS` and `SHA256SUMS.minisig` (minisign, Ed25519, non-prehashed). The updater and `scripts/install.sh` verify the signature against the pinned public key in `rust/vst-daemon/release-keys/vst-release.pub` and in `PINNED_PUBKEYS` in `scripts/install.sh`. The two pins must hold the same keys (`scripts/check-pinned-keys-in-sync.sh`).
- Asset hashes come only from the verified manifest. A missing, malformed or unknown-key signature, a tag mismatch, or a hash mismatch aborts and leaves the installed binary untouched. It fails closed and no flag skips it.
- macOS binaries and the dmg are Developer-ID signed, hardened-runtime and notarized in CI (`scripts/macos-ci-sign.sh`, `scripts/macos-verify-signed.sh`). Without minisign or OpenSSL 3, `install.sh` on macOS instead requires every binary to carry a valid signature from the pinned `APPLE_TEAM_ID` (set in `scripts/install.sh`).
- CI also publishes build-provenance attestations.
- Not covered: the first `curl | sh` install (trust is TLS plus GitHub serving `install.sh`), and a replay of an older signed release in `install.sh` above its `MIN_RELEASE` floor. Bump `MIN_RELEASE` in the PR of any security release.

## Releasing

Pushing a tag `v*` runs `.github/workflows/release.yml`. Re-run by hand with `gh workflow run release.yml --ref vX.Y.Z -f tag=vX.Y.Z` (must run on the tag). Any semver prerelease part marks the GitHub release as a prerelease. Preflight refuses a tag whose commit is not reachable from `main`, and any tag whose release is already published (cut a new tag instead). The release runs with no manual approval: `sign-macos` and `sign-manifest` (`release-signing`) and `publish-release` (`release-publish`) start by themselves. A release is never published unsigned: the macOS and manifest signing jobs fail closed and publish needs both. The controls are a GitHub tag ruleset on `refs/tags/v*` (admins only can create, update or delete), the on-`main` check, and environments limited to `v*` tags. To add a manual gate later, add a required reviewer to the two environments. Unsigned build output is kept 7 days between the build and signing jobs.

**Environments.** Each key set is reachable from one job only. All three have a deployment rule limited to tags `v*`; create them before the first release (an unconfigured environment is created without protection). Names only:

| Environment | Job | Secrets |
|-------------|-----|---------|
| `release-signing` | `sign-macos`, `sign-manifest` (the latter only references the two minisign secrets) | `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (App Store Connect API key: the `.p8` file text, its key ID and issuer ID) |
| `release-publish` | `publish-release` | none (the job's `contents: write` token creates the release with `gh`, no third-party action) |

**Job rules** (enforced by `scripts/check-workflow-policy.rb`, mutation-tested in `scripts/test-release-policy.sh`). A job with an environment, a secret or a write token uses only `actions/checkout`, `download-artifact` and `upload-artifact` (plus `attest-build-provenance` in the attest job), and installs nothing. Every `run` line in the three secret/write jobs is on an allow-list. `sign-manifest` fetches minisign from one pinned upstream tarball and checks its sha256 before unpacking (no package manager, no root). No job-level `if:`, no `continue-on-error`, and the `needs` graph is fixed.

The macOS CLI binaries and desktop app are built unsigned in jobs with no environment and no secrets, and uploaded as plain data (`unsigned-cli-*`, `unsigned-desktop-*`, with a sha256 manifest). `sign-macos` runs on a fresh runner, checks out the tagged commit itself, installs nothing, never executes the downloaded data, and runs only scripts from its own checkout. Unpacking accepts only regular files, directories and bundle-internal relative symlinks, with explicit safe `tar` flags. It signs, notarizes, staples, repacks (the dmg must hold exactly one `.app`; only `Applications`, `.background`, `.DS_Store` and `.VolumeIcon.icns` may sit beside it) and verifies, then uploads the final `cli-*` / `desktop-*` artifacts. `sign-manifest` takes each asset from its one expected artifact (`scripts/collect-release-assets.sh`) and refuses missing, duplicate or extra files. If the macOS secrets are all present CI signs and any failure fails the release. If none are present (forks) it builds unsigned with a warning. A partial set is an error. Set the Apple ones with `scripts/macos-export-signing-secrets.sh`. A notarization submission id is printed as soon as it exists; if a step times out, look it up with `xcrun notarytool info <id>` (same API key).

**What the signing jobs still trust.** `sign-macos` signs and notarizes whatever bytes the build jobs produced (`vst`, `claude-acp`, `codex-acp`, everything inside the `.app`, the dmg layout within the allow-list above); the sha256 manifest is only a transport check. A compromised build job (for example a poisoned dependency) therefore cannot read the keys, but its output would be signed, notarized and published. What limits that is the pinned lockfiles, `cargo deny` and review of the tagged commit. The on-main check and the tag ruleset stop accidents and outsiders, not a maintainer with write access.

Apple lets you download the `.p8` key only once — store it in a password manager before loading it as a secret.

**Generate or rotate the minisign key:**

1. `minisign -G -p vst-release.pub -s vst-release.key`, offline, with a strong password.
2. `gh secret set MINISIGN_SECRET_KEY --env release-signing < vst-release.key`, then `gh secret set MINISIGN_PASSWORD --env release-signing` (hidden prompt). Back both up in a password manager.
3. Copy `vst-release.pub` to `rust/vst-daemon/release-keys/vst-release.pub`, and its second line to `PINNED_PUBKEYS` in `scripts/install.sh`.
4. Rotation: release N pins OLD and NEW but is still signed with OLD. Switch the secrets to NEW only after most clients are on N. Drop OLD from both pins in a later release.
5. Compromise: delete the secrets, make a new key, ship an emergency release pinning only NEW. Old clients cannot auto-update, so publish `curl | sh` reinstall instructions.

CI `preflight` refuses to release if either pin is the placeholder test key (`scripts/check-release-key-not-placeholder.sh`).

**Verify a release:**

```bash
gh attestation verify vst-x86_64-unknown-linux-musl.tar.gz --repo fastestdevalive/vibe-station
minisign -Vm SHA256SUMS -P "<line 2 of rust/vst-daemon/release-keys/vst-release.pub>"
sha256sum -c --ignore-missing SHA256SUMS
```

## Internal knobs and invariants

Not user settings; set by the daemon, the desktop app or tests.

| Variable | Set by / read by |
|----------|------------------|
| `VST_RESTART_NONCE`, `VST_RESTART_PORT` | The old daemon (`restart::exec_successor`) and the rollback watcher set them for the next daemon, which reads and removes them at boot (`restart::take_restart_env`). Names are `ENV_RESTART_*` in `update/restart/mod.rs`. `vst-cli/src/launch.rs` strips them from a freshly launched daemon. |
| `VST_HOSTED_BY=tauri` | Set by `desktop/src-tauri/src/daemon.rs`; `UpdateService` then refuses in-place restarts (`tauri_hosted`). Also stripped in `launch.rs`. |
| `VST_RESTART_WATCH_WINDOW_MS` | Test only: shrinks both watcher phases (`watch::watch_windows`). Exists only with `test-seams`. |
| `VST_TEST_RELEASE_PUBKEYS` | Test only: replaces the pinned minisign keys (`signature::pinned_keys`). Exists only with `test-seams`. |

- **`test-seams`** (cargo feature of `vst-daemon`) is the single gate for every test seam (the env vars above, `UpdateService::*_for_tests`, `signature::test_support`). It is enabled only through dev-dependencies; optimized builds fail with `compile_error!` and release CI greps the binary for the markers. Never enable it for a shipped build.
- **Files and locks:** every on-disk name under the vst home (`update-state.json`, `.update.lock`, `.daemon.lock`, `restart-handoff.json`, `.prev/vibe-station.db`, `logs/update-watch.log`) is built in `update/paths.rs` only. Older and newer binaries read each other's files across a restart or rollback, so never rename one; add new fields with `#[serde(default)]`.
- **Timing:** every restart, rollback and handoff constant lives in `update/timing.rs`. The watcher phases plus the successor's lock retry must fit inside `UI_CLI_RESTART_WAIT` (75 s), and the handoff TTL must outlive the watcher (`timing_budget_holds` in `watch.rs`). Web mirrors (`RESTART_WAIT_MS` in `RestartOverlay.tsx`, `FORCE_FLOOR_MS` in `UpdateSetting.tsx`) are checked by `rust/vst-daemon/tests/update_ui_mirrors.rs`.
- **Replace order and names:** `install/replace.rs` renames adapters first and `vst` last, and `KNOWN_NAMES` must keep every binary name ever shipped (including legacy ones) so a rollback recognises old installs.
- **Watcher:** it is spawned from `.vst.prev` (the old binary), so its argument parser (`WatchArgs`) must stay backward compatible: keep every flag, never require a new one.

## Where the code lives

| Path | Role |
|------|------|
| `rust/vst-daemon/src/update/` | `service/` (check, install ops), `state.rs`, `install/`, `restart/`, `handoff.rs`, `watch.rs`, `routes.rs`, `paths.rs`, `timing.rs` |
| `rust/vst-daemon/src/update/install/signature.rs` | Manifest signature check against the pinned keys |
| `rust/vst-daemon/release-keys/vst-release.pub` | Pinned minisign public key |
| `rust/vst-types/src/rest/update.rs` | Wire types (`UpdateStatus`, `InstallMethod`); mirrored in `web-ui/src/api/types.ts` |
| `rust/vst-cli/src/commands/update.rs`, `commands/daemon/` | `vst update`, `vst daemon restart` |
| `web-ui/src/components/update/`, `components/settings/UpdateSetting.tsx` | Chip, dialog, restart overlay, Settings > Updates |
| `scripts/install.sh` | curl installer: pinned keys, `MIN_RELEASE`, `APPLE_TEAM_ID` |
| `.github/workflows/release.yml`, `scripts/*sign*.sh`, `scripts/make-release-manifest.sh` | Build, sign, attest, publish; tests are `scripts/test-release-*.sh` |
