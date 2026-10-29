# Fixes — cloudflared-detached, round 1

Scope: High/Med defects only (V1). V2/V3/V4 are Low and left open (documented below).

### V1 [Med] — installed cloudflared is not shown with its path and version

- **Problem:** `TunnelState.binary` is fetched with `?binary=1` and stored, but `TunnelCard` only branches on `blocked` (not_installed/unusable). The `installed` variant falls through to the generic "Tunnel off" / "Enable tunnel" card, so the path + version the locator just resolved are never rendered. A user cannot tell which `cloudflared` vst will spawn (multiple installs, a stale `VST_CLOUDFLARED_BIN`, brew vs apt), and the verify check "(b) installed with path+version" fails even though the daemon reports both.
- **Expected:** When `binary.state === "installed"`, the card shows the located binary and its probed version (muted, selectable, same visual language as the `unusable` line), in both the active and the off state.
- **Change:** `web-ui/src/components/settings/RemoteAccessSetting.tsx`, `TunnelCard`: in the non-blocked branch, render a muted line `cloudflared <version> at <path>` when `binary?.state === "installed"`, above the active/off status box. No new props, no new fetch, no timer; older daemons (no `binary`) keep the exact current card. Extend `RemoteAccessSetting.test.tsx`'s 2.T5 installed case to assert the version + path are shown (guards the regression).
- **Acceptance:** Sandbox: after the stub install + Re-check the card reads `cloudflared 2025.1.0 at /home/vst/.local/bin/cloudflared` above "Tunnel off" (screenshot `cloudflared-installed.png` refreshed). `tsc --noEmit` and the web test suite green; the not-installed/unusable/older-daemon cards unchanged.

## Left open (Low)

- **V2 [Low]** — install command blocks wrap mid-URL inside the ~300px settings card. Cosmetic; the block is shared with the Doctor page (`CommandBlock`/`doctor.css`), so widening it belongs to that component, not this feature.
- **V3 [Low]** — `vst doctor` prints only the apt block (the RHEL entry is dropped because `DoctorCheck.installHint` is a single string). Plan 1.10 accepted this shape; a fix would change the doctor wire type.
- **V4 [Low]** — no Re-check button once installed (matches plan 2.1); a binary that breaks later needs a reload or an Enable click (409 → auto refetch).

REMAINING_ISSUES: 3
