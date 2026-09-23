# 3.T9 — RESOLVED (Docker sandbox visual confirmation)

**Plan:** `.vibekit/feature-plans/wip/search-ux-nav-and-layout/plan-search-ux-nav-and-layout.md`
**Branch:** `search-ux-nav-and-layout`
**Scope of this file:** only checklist item **3.T9**. Phase 3 is now fully complete —
3.T9 is checked off in the plan.

## What was blocking it

Two previous attempts (see git history of this file) got the dev sandbox container
built and started, but its bundled Rust daemon binary failed to boot:

    /usr/local/bin/vst-daemon-rust: /lib/x86_64-linux-gnu/libc.so.6:
    version `GLIBC_2.39' not found (required by /usr/local/bin/vst-daemon-rust)

Root cause, confirmed by inspection: `docker-compose.dev.yml` bind-mounts the Rust
daemon binary read-only from a **host-built** path
(`${VST_RUST_DAEMON_BIN:-./rust/target/release/vst-daemon}`), it is not built inside
the image. This host's toolchain (`rustc`/`cargo` 1.98.1) runs on Ubuntu with glibc
2.39; `dev.Dockerfile`'s base image is `node:24-slim` (Debian bookworm, glibc 2.36).
A binary built on this host is linked against symbols the container's older glibc
doesn't have.

## The fix that worked

`scripts/dev-sandbox.sh` already anticipates exactly this: on `up`, before falling
back to `./rust/target/release/...`, it first checks for binaries at
`./rust/target-docker/{debug,release}/vst-daemon` — and `.gitignore` already has a
comment describing `rust/target-docker/` as "a one-off containerized release build
(built inside node:24-slim to match the dev-sandbox's glibc)". So the intended
workaround was already documented in-repo; it just hadn't been done for this
worktree/host pairing yet.

Steps that resolved it:

1. Pulled the exact-version toolchain image the repo pins
   (`rust/rust-toolchain.toml` → `channel = "1.98.1"`): `rust:1.98.1-bookworm`
   (bookworm matches `dev.Dockerfile`'s `node:24-slim`, so the glibc lines up).
2. Built inside that container against the bind-mounted `rust/` source:
   ```
   docker run --rm -v "$(pwd)/rust":/work -w /work \
     -v vst159-cargo-registry:/usr/local/cargo/registry \
     rust:1.98.1-bookworm cargo build --release -p vst-daemon -p vst-cli
   ```
   (~2m20s cold build on this host.)
3. Copied the resulting binaries into `rust/target-docker/release/` (gitignored,
   not a standard cargo output location — `dev-sandbox.sh` looks there first):
   ```
   mkdir -p rust/target-docker/release
   cp rust/target/release/vst-daemon rust/target/release/vst rust/target-docker/release/
   ```
4. `scripts/dev-sandbox.sh up vs-159 --port=7142 --seed=file-search` — picked up the
   `target-docker` binaries automatically (its own preference order), and the daemon
   booted clean this time — no GLIBC error, `vst daemon listening on http://0.0.0.0:7421`,
   Vite ready.

`--seed=file-search`'s own project-registration step failed non-fatally (its curl
call reads a bearer token from `~/.vibe-station/config.json` that isn't populated
under `VST_NO_AUTH=1` — a pre-existing, unrelated seed-script gap, not this
feature). Worked around by registering the already-seeded repo directly:
`curl -X POST http://localhost:7142/api/projects -d '{"path": "/home/vst/projects/file-search-demo"}'`
(no auth header needed since `VST_NO_AUTH=1` disables auth entirely). A human
re-running this later may want to fix `scripts/seed-file-search-demo.sh` to also
work under `VST_NO_AUTH`, but that's out of scope here.

## What was visually confirmed (in-browser, via claude-in-chrome, on port 7142)

Created a worktree (`say-hello`, project `file-search-demo`) to get a live Files
tool tab (the underlying agent process itself failed to spawn — no ACP claude
binary wired into this throwaway sandbox — irrelevant to this UI check).

- **Rail renders correctly**: 3-icon rail (▤ layout-toggle / ⊟ tree / 🔍 search) is
  a persistent narrow strip, full-height sibling of the tree/search pane and the
  preview pane, matching the mockup's structure.
- **Mode header swap**: clicking 🔍 swaps the left-pane header from the tree's
  `Files | local | branch` chip row to the search UI's query input + `Aa .* \b`
  toggles + glob filter field — same slot, different content, matching the mockup.
- **Always-mounted, not unmounted**: typed a query ("function", 8 matches across
  `src/components/*.tsx`), switched rail mode tree → search → tree → search; the
  query text and full result list were still there on return — confirms both
  bodies stay mounted rather than remounting/losing state.
- **Live peek while arrowing**: pressing Enter in the query field seeds the roving
  cursor onto the first result row and focuses it; arrowing down through match rows
  live-updates the shared preview pane (confirmed via DOM inspection —
  `search-panel__match-row--cursor` tracks the focused row, and the preview pane's
  content changed from `Header.tsx` → `Dialog.tsx` as the cursor moved) — critically,
  the preview's tab strip stayed on "No file open" the entire time; no `×` tab was
  ever added by arrow navigation. Only an explicit click on a match row committed a
  real tab (opened `Dialog.tsx ×` in the strip), matching the mockup's "only
  Enter/click commits" annotation.
- **Peek survives a mode switch**: while peeking `Dialog.tsx` via arrow-key cursor,
  switched rail mode to tree and back to search — the peeked preview content
  remained visible throughout, confirming `clearPeekFile()` is not called on a rail
  mode switch (Follow-up #3's resolution).
- **`Mod+Shift+F`**: with focus outside the search UI (clicked into the chat/
  terminal pane, rail in tree mode), `Ctrl+Shift+F` switched the rail to search mode
  and moved DOM focus onto the query input (`document.activeElement` was the
  `search-panel__input`), confirming the shortcut both opens Files+search mode and
  focuses the query field.

All of the above matches the confirmed rail mockup in the report's "Addendum —
confirmed rail mockup" section. 3.T9 is checked off `[x]` in the plan.

## Cleanup performed

- Sandbox torn down: `scripts/dev-sandbox.sh down vs-159` (container/network
  removed; per-worktree volumes `vst-dev-data-vs-159` / `vst-dev-projects-vs-159`
  left intact, as the script does by design — `down` never implies `-v`).
- Browser tab closed.
- `rust/target-docker/release/{vst-daemon,vst}` left in place (gitignored) — a
  future `dev-sandbox.sh up` on this same host will pick them up again without
  needing to rebuild, as long as the Rust workspace hasn't changed since. If it
  has, rebuild with the same `docker run ... rust:1.98.1-bookworm cargo build
  --release -p vst-daemon -p vst-cli` command above and re-copy into
  `rust/target-docker/release/`.
