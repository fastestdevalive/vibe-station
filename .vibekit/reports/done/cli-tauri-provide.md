# CLI + Skills in Tauri — Design Recommendations

_Branch: `cli-tauri-provide` · Status: Refining_

---

## What this change achieves

| What | Who benefits | Notes |
|---|---|---|
| `vst` available inside every agent terminal, no extra install | AI agents | Daemon prepends `~/.vibe-station/bin` to agent PATH automatically |
| Full `vst` reference readable on demand via `$VST_SKILL_PATH` | AI agents | Any harness (Claude, OpenCode, Cursor, Aider) can `cat $VST_SKILL_PATH`; Claude also gets `/vst` skill invocation |
| `vst daemon start/stop/restart` removed | App users + devs | Prevents breaking the Tauri-managed daemon; error messages updated to direct users to the app |
| `vst` available in any user terminal immediately after app install | End users | No separate CLI install step; shell config updated on first launch |
| `vst open <path>` opens a project window, launching the app if needed | End users | Analogous to `code .`; replaces the vestigial browser-launcher behavior |

---

## Context

The Tauri app currently bundles only `vst-daemon` and `cloudflared` as sidecars. There is no `vst` CLI binary bundled, and no PATH manipulation happens when the daemon spawns agent processes. The agent system prompt (`daemon/src/assets/agent-system-prompt.md`) references `vst` commands ~20 times, but agents have no guaranteed access to the binary. Separately, `skill/SKILL.md` (the full `vst` reference — REST API, WS protocol, spawn recipes) is never installed or auto-registered anywhere.

---

## Recommendation 1 — `vst` binary + skill bundled together, implicitly available to agents

### The problem (two parts)

1. **Binary**: agents don't have `vst` on PATH unless the user separately installed the CLI.
2. **Knowledge**: even with the binary, agents only know the subset of commands in the L1 system prompt. The full `vst` reference lives in `skill/SKILL.md` and is never surfaced to agents.

### Proposed solution

**Bundle `vst` as a Tauri sidecar + `skill/SKILL.md` as a Tauri resource, inject PATH + auto-register the skill into the ACP catalog at session start.**

#### Step 1 — Build `vst` CLI sidecar (`scripts/prep-sidecar.sh`)

The `prep-sidecar.sh` pipeline already builds `vst-daemon` via `esbuild → @yao-pkg/pkg`. Add a parallel step:

```bash
node_modules/.bin/pkg cli/dist/main.js \
  --target node18-linux-x64 \
  --output dist/vst-${TRIPLE}
cp dist/vst-${TRIPLE} desktop/src-tauri/binaries/vst-${TRIPLE}
```

> **Note**: confirm `cli/`'s esbuild output format is `"format": "cjs"` — `@yao-pkg/pkg` requires CJS input and will fail silently on ESM.

Register in `tauri.conf.json`:
```json
"externalBin": ["binaries/vst-daemon", "binaries/vst", "binaries/cloudflared"]
```

Add to `capabilities/default.json` allowlist (same pattern as `vst-daemon`). Tauri passes `VST_CLI_BIN` pointing to the buried sidecar path to the daemon at launch (alongside existing `VST_CLOUDFLARED_BIN` pattern in `daemon.rs`).

#### Step 2 — Bundle `skill/SKILL.md` as a Tauri resource

```json
"bundle": { "resources": ["../../skill/SKILL.md"] }
```

Tauri resolves the absolute path at runtime; pass it to the daemon as `VST_SKILL_PATH`.

#### Step 3 — Stable daemon-owned paths + shim

At daemon boot, resolve both the binary source and skill source, then materialise them under `~/.vibe-station/`:

```ts
// daemon/src/lib/resolveVstPaths.ts
export function resolveVstCliBinSource(): string | undefined {
  if (process.env.VST_CLI_BIN) return process.env.VST_CLI_BIN;
  // Dev fallback: cli/dist/main.js (relative to cli/dist/daemon/ location)
  // Note: __dirname is a real path here (daemon runs outside pkg snapshot)
  const candidate = path.resolve(__dirname, "../../main.js");
  return fs.existsSync(candidate) ? candidate : undefined;
}

export function resolveVstSkillSource(): string | undefined {
  if (process.env.VST_SKILL_PATH) return process.env.VST_SKILL_PATH;
  // Dev fallback: skill/SKILL.md at repo root
  const candidate = path.resolve(__dirname, "../../../../skill/SKILL.md");
  return fs.existsSync(candidate) ? candidate : undefined;
}
```

Write a shim to `~/.vibe-station/bin/vst` that works for both the Tauri-packaged case (native binary) and the dev case (Node.js script):

```ts
const shimDir = path.join(os.homedir(), ".vibe-station", "bin");
await fs.mkdir(shimDir, { recursive: true });

const src = resolveVstCliBinSource();
const shimContent = src?.endsWith(".js")
  ? `#!/bin/sh\nexec node ${src} "$@"\n`        // dev: wrap node
  : `#!/bin/sh\nexec ${src} "$@"\n`;             // Tauri: proxy native binary

await fs.writeFile(path.join(shimDir, "vst"), shimContent, { mode: 0o755 });
```

Copy the skill file to its stable daemon-owned path (atomic temp+rename):

```
~/.vibe-station/skill/vst/SKILL.md
```

**PATH injection** in `daemon/src/services/context.ts` — a single prepend covers both modes:

```ts
const vstBinDir = path.join(os.homedir(), ".vibe-station", "bin");
env.PATH = `${vstBinDir}:${process.env.PATH}`;
```

`~/.vibe-station/bin/` is the daemon-owned tool directory (analogous to AO's `~/.ao/bin/`). Future tools land here without touching `context.ts` again.

Inject `VST_SKILL_PATH` into every agent env pointing to `~/.vibe-station/skill/vst/SKILL.md`. Any agent — Claude, OpenCode, Cursor, Aider — can read it:

```bash
cat $VST_SKILL_PATH
```

#### Step 4 — ACP catalog + harness skill dir install

For Claude-based agents, register the skill in the ACP `available_commands_update` catalog (sent with the `session/new` acknowledgment, after daemon-boot skill installation completes) so `/vst` works as a skill invocation:

```ts
catalog.push({ name: "vst", path: resolveVstSkillPath() });
```

Also install to harness skill directories using emdash-style config resolvers — the same resolvers that drive the existing autocomplete skill scan (`daemon/src/services/config.ts:57-65`), replacing the current hardcoded array:

```ts
// daemon/src/lib/harnessSkillDirs.ts
const HARNESS_SKILL_RESOLVERS = [
  () => path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "skills"),
  () => path.join(process.env.GEMINI_CONFIG_DIR ?? path.join(os.homedir(), ".gemini"), "skills"),
];
```

Install is idempotent via a version marker file; overwrites only on version bump. This gives Claude and Gemini native `/vst` skill invocation outside of vibe-station sessions too.

#### Step 5 — L1 system prompt pointer

Append one line to `daemon/src/assets/agent-system-prompt.md`:

```markdown
The full `vst` CLI reference (REST API, WS protocol, advanced patterns) is at
$VST_SKILL_PATH — read it when you need detail beyond what's listed above.
```

---

## Recommendation 2 — Remove daemon start/stop/restart from CLI

The daemon lifecycle is Tauri-owned: launched on first window, killed when the app quits. `vst daemon start/stop/restart` are misleading (CLI-started daemon bypasses `tauriToken`; the window won't connect), harmful in dev (stops the app-managed daemon), and unreachable for app users.

**Changes:**

1. **Delete** `cli/src/commands/daemon/start.ts`, `stop.ts`, `restart.ts`
2. **Update** `cli/src/program.ts` — remove those three subcommands
3. **Keep** `vst daemon status` — update output: _"Daemon is managed by the vibe-station desktop app. Launch the app to start it."_
4. **Update** `cli/src/lib/preflight.ts` — replace "Run `vst daemon start`" with "Open the vibe-station app to start the daemon."
5. **Update** `cli/src/commands/doctor.ts` — same messaging change

> **Dev note**: `scripts/dev-start.sh` starts the daemon directly for the web-UI dev flow. Agent spawn / skill / session work requires the Tauri window to be open — `vst daemon start` is no longer the answer.

---

## Recommendation 3 — `vst` on system PATH after app install + `vst open <path>`

### Part A — PATH installation

**Option A — Shell config shim on first launch** (all platforms, zero sudo)

The daemon appends to shell configs on first boot, using the correct idiom per shell:

```ts
const SHELL_CONFIGS: Array<{ path: string; line: string }> = [
  {
    path: path.join(os.homedir(), ".zshrc"),
    line: `\nexport PATH="$HOME/.vibe-station/bin:$PATH"  # added by vibe-station\n`,
  },
  {
    path: path.join(os.homedir(), ".bashrc"),
    line: `\nexport PATH="$HOME/.vibe-station/bin:$PATH"  # added by vibe-station\n`,
  },
  {
    path: path.join(os.homedir(), ".config", "fish", "config.fish"),
    line: `\nfish_add_path $HOME/.vibe-station/bin  # added by vibe-station\n`,  // fish array idiom
  },
];
```

> **Fish gotcha**: fish does not support `export PATH="...:$PATH"` — `$PATH` expands to a space-separated list and the colon is treated as a literal, corrupting PATH. Use `fish_add_path` instead.

**Option B — Package manager post-install symlink** (Linux `.deb`/`.rpm` only)

```bash
#!/bin/sh
ln -sf /usr/lib/vibe-station/vst /usr/local/bin/vst
```

A + B together: A is the universal baseline (AppImage, macOS DMG), B adds zero-friction coverage for distro installs.

#### Sidecar location after install

| Platform | Buried path |
|---|---|
| macOS `.app` | `vibe-station.app/Contents/MacOS/vst-aarch64-apple-darwin` |
| Linux `.deb` | `/usr/lib/vibe-station/vst-x86_64-unknown-linux-gnu` |
| Linux AppImage | Inside squashfs; only accessible while mounted |

Not on PATH by default — Options A + B are what surface it.

### Part B — `vst open <path>`

The existing `cli/src/commands/open.ts` calls `xdg-open`/`open` on `localhost:5173` — a vestigial dev browser-launcher. It will be fully replaced.

**1. Daemon route: `POST /open`**

Upserts the project (same as `vst project add <path>`), then emits a `navigate` WS event. To avoid a race where the event fires before the Tauri window's WS connection is established, the daemon holds the last `navigate` payload for ~3s and replays it to any client that connects within that window:

```ts
// POST /open { path: "/abs/path" }
// → upsert project → store lastNavigate = { projectId, expiresAt: now + 3s }
// → emit WS: { type: "navigate", projectId }
// WS on-connect: if lastNavigate not expired → replay to new client
```

**2. Tauri window `navigate` handler**

One React hook on the existing WS connection: on `navigate` event, call `router.push(/projects/${projectId})`.

**3. CLI launch-if-not-running**

```ts
// macOS
execSync('open -a "vibe-station"');
// Linux deb/rpm
execFileSync('/usr/lib/vibe-station/vibe-station');
// Linux AppImage: resolve via readlink /proc/self/exe → walk to app root
```

Poll `~/.vibe-station/config.json` for up to 10s, then call `POST /open`.

**4. `vst open <path>` rewritten**

Resolve `target` to absolute path → call `POST /open` → handle launch-if-not-running. Old browser behavior gone.

#### Effort

| Piece | Effort |
|---|---|
| Option A shell config shim (with fish fix) | ~2 hours |
| Option B `.deb`/`.rpm` postInstall | ~2 hours |
| `POST /open` + navigate replay buffer | ~1 day |
| Tauri window `navigate` event handler | ~2 hours |
| `vst open` rewrite + launch-if-not-running (macOS) | ~half day |
| launch-if-not-running (Linux) | ~1 day |
| **Total** | **~2–3 days** |

PATH install (A + B) is independent — worth shipping first.

---

## Files changed (summary)

| File | Change |
|---|---|
| `scripts/prep-sidecar.sh` | Add `vst` sidecar build step; confirm CJS output format |
| `desktop/src-tauri/tauri.conf.json` | Add `vst` to `externalBin`; add `SKILL.md` to `resources` |
| `desktop/src-tauri/capabilities/default.json` | Add `vst` to allowlist |
| `desktop/src-tauri/src/daemon.rs` | Pass `VST_CLI_BIN` + `VST_SKILL_PATH` to daemon |
| `daemon/src/lib/resolveVstPaths.ts` | New — resolve binary + skill paths (Tauri + dev fallback) |
| `daemon/src/lib/harnessSkillDirs.ts` | New — config resolvers for harness skill dirs |
| `daemon/src/services/context.ts` | Prepend `~/.vibe-station/bin` to agent PATH |
| `daemon/src/services/config.ts` | Replace hardcoded skill dirs with `resolveHarnessSkillDirs()` |
| `daemon/src/services/userSkillCatalog.ts` | Auto-register `vst` skill in ACP catalog |
| `daemon/src/assets/agent-system-prompt.md` | Add `$VST_SKILL_PATH` pointer line |
| `daemon/src/routes/open.ts` | New — `POST /open` with navigate replay buffer |
| `cli/src/commands/open.ts` | Rewrite — path → `POST /open` + launch-if-not-running |
| `cli/src/commands/daemon/start.ts` | **Delete** |
| `cli/src/commands/daemon/stop.ts` | **Delete** |
| `cli/src/commands/daemon/restart.ts` | **Delete** |
| `cli/src/program.ts` | Remove start/stop/restart; update `open` registration |
| `cli/src/lib/preflight.ts` | Update error message |
| `cli/src/commands/doctor.ts` | Update daemon-not-running message |
