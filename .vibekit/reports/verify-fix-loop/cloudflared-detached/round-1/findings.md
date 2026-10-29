# Verify — cloudflared-detached, round 1

Sandbox: `scripts/dev-sandbox.sh up vs-293-cf --port=7120 --seed=file-search` (VST_NO_AUTH=1, Linux image, no cloudflared).
UI driven with Playwright (headless chromium) against `http://localhost:7120/settings/remote-access`; OOBE completed via `/api/oobe/*`.

## Check results

| # | Check | Expected | Actual | Verdict |
|---|-------|----------|--------|---------|
| a | Settings → Remote Access, cloudflared absent | Distinct `not_installed` state (not a fake "off"): info box, Linux apt block + RHEL block, Docs link, Re-check button, no Enable tunnel | Exactly that; `binary.state="not_installed"`, `hostOs="linux"`, both Linux commands rendered as separate copy blocks | **PASS** |
| b | Drop stub in `~/.local/bin`, click Re-check (no daemon restart) | Flips to `installed` **with path + version** | Flips to the plain "Tunnel off" + "Enable tunnel" card within one click; `GET ?binary=1` returns `installed{path,version}`, but the UI never renders either | **FAIL** (V1) |
| c | Replace stub with `exit 1`, Re-check | `unusable` with its error | Warn box: `cloudflared at /home/vst/.local/bin/cloudflared is unusable: --version failed with exit code 1: exec format error: cannot run`, hint block, Re-check, no Enable; stays unusable on a second Re-check; fixing the stub + Re-check flips back to installed | **PASS** |
| d1 | `GET /api/auth/tunnel/status` (no binary field) | Old three-field body, no probe | `{"enabled":false,"tunnelUrl":null,"startedAt":null}` | **PASS** |
| d2 | `GET /api/auth/tunnel/status?binary=1` (and `?binary=true`) | `binary` + `hostOs` + `installHint` when not installed; hint omitted when installed | not-installed: `binary{not_installed}`, `hostOs:"linux"`, hint with 4 commands (macos, 2×linux, windows) and canonical docsUrl. installed: `binary{installed,path,version}`, `hostOs`, **no** `installHint` | **PASS** |
| d3 | `POST /api/auth/tunnel/enable` in sandbox | 409 (NoAuthMode), not a spawn error | `409 {"error":"Tunnel unavailable in no-auth mode"}` | **PASS** (expected, not a defect) |
| d4 | `GET /api/doctor` | cloudflared check present, sourced from locator | `{name:"cloudflared", status:"warn", required:false, message:"cloudflared not installed", installHint:<apt block>, hint:{...}}` | **PASS** |
| d5 | `vst doctor` in container | Locator-based line + install hint | `✗ cloudflared not installed` + apt block | **PASS** (see V3) |
| e | Desktop layout 1440×900 | Readable card, no clipping | Cards fit; long install commands wrap inside the ~300px card | **PASS** (see V2) |
| f | Phone layout 390×844 | No horizontal overflow | `scrollWidth == clientWidth == 390`; card stacks full width, commands wrap | **PASS** |

Console: no errors/warnings from the page during any of the above.

## Findings

| id | severity | expected | actual | screenshot | suspected file |
|----|----------|----------|--------|------------|----------------|
| V1 | Med | `installed` is reported with the located path and probed version, so the user can tell which cloudflared vst will run (especially with `VST_CLOUDFLARED_BIN`/multiple installs) | Installed collapses into the pre-existing "Tunnel off / Enable tunnel" card; `binary.path` and `binary.version` are fetched and stored but never rendered anywhere | `cloudflared-installed.png` | `web-ui/src/components/settings/RemoteAccessSetting.tsx` (`TunnelCard`, non-blocked branch) |
| V2 | Low | Install commands are comfortably readable in the settings card | At desktop width the Cloudflare card is ~300px wide, so the apt block wraps mid-URL (`https://pkg.cloudflare.c` / `om/...`) and the block is ~300px tall; readable but awkward. Phone (390px, full-width card) is better | `cloudflared-not-installed.png`, `cloudflared-not-installed-phone.png` | `web-ui/src/components/doctor/CommandBlock.tsx` / `doctor.css` (shared with the Doctor page; out of scope here) |
| V3 | Low | CLI shows the same install guidance as the UI (apt + RHEL) | `vst doctor` prints only the apt block (`DoctorCheck.installHint` is a single string, so the RHEL entry is dropped) | — | `rust/vst-daemon/src/doctor.rs` (check shape) / `rust/vst-cli/src/commands/doctor.rs` |
| V4 | Low | A binary that becomes broken after install can be re-probed without a reload | Re-check only exists in `not_installed`/`unusable`; once installed the only path to re-probe is an Enable click (409 → auto refetch) or a page reload. Matches plan 2.1, so informational | `cloudflared-installed.png` | `RemoteAccessSetting.tsx` |

## Notes

- Plan 2.V4 is now verified end-to-end for the sandbox part (not-installed → stub → Re-check → installed without restart; broken stub → unusable with error). Real `enable()` stays unverified here by design (VST_NO_AUTH 409).
- `?binary=1` is the only probing caller; the plain status body is unchanged, so `parity_harness` semantics hold (gate confirms).
