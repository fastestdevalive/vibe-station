# CLI terminal launch pitfalls (found via pi, vs-230)

Status: **fixed in cli-launch-hardening** — both bugs below are resolved; this
page keeps the investigation, the final design, and the onboarding checklist
(moved to `docs/PLUGINS.md`).
Goal: a general solution so onboarding a new CLI terminal (after claude, cursor, opencode, agy, codex, pi, omp)
doesn't mean rediscovering the same launch/resume bugs.

## Final design (cli-launch-hardening)

- **PATH capture:** the daemon captures the user's interactive-shell PATH once
  at startup (`context::effective_path`, cached in a `OnceLock`; `$SHELL -ilc`
  with marker-delimited output, 5s timeout, process-group kill, non-fatal — falls
  back to the daemon PATH). `build_vst_env` still prepends `~/.vibe-station/bin`
  and appends any unseen shell dirs.
- **No login shell:** shell-launched agents run as `sh -c "exec <line>"`
  (`shell_command_parts` in `rust/vst-routes/src/sessions.rs`) — the daemon-built
  PATH reaches the CLI unchanged.
- **Preflight:** before any spawn, `ensure_binary_on_path` (`registry.rs`)
  resolves the plugin's `binary_name()` against the session PATH and fails with
  `` `<bin>` not found on PATH (searched: ...) `` — `exited` with that reason on
  create (async spawn job), an immediate `Err` on resume/toggle.
- **Restore contract:** `get_restore_command` MUST return `None` for a session
  with no stored id and no conversation; SHOULD verify ≥ 1 user turn. pi gates
  restore/capture/`chat_established` on `~/.pi/agent/sessions/*/*_<id>.jsonl`
  containing a `role == "user"` message. `resume_spawn` replays the initial
  prompt when `initial_prompt.is_some() && (agent_chat_id.is_none() || !chat_established)`.
  Enforced by the cross-plugin test `rust/vst-agents/tests/restore_contract.rs`.

## TL;DR

pi agents exited right after launch, and Resume didn't continue the work. Two independent bugs:

1. **Launch:** the daemon starts shell-launched agents with `sh -lc`. The login shell resets `PATH`, so a CLI installed
   outside the reset PATH (pi and codex live under `~/.nvm/...`) fails with `command not found` (exit 127) on its first run.
2. **Resume:** pi's `get_restore_command` always returns a "resume" command, even when the conversation never started,
   so Resume never re-sends the original prompt.

Bug 1 is a latent shared-path issue pi happened to expose. Bug 2 is a missing guard in the pi plugin.

## Background: what is `sh -lc "<line>"`?

- `sh` — the POSIX shell (on Debian/Ubuntu this is `dash`).
- `-c "<line>"` — run the string `<line>` as a command, then exit.
- `-l` — **login shell**: before running the command, the shell sources the login startup files
  (`/etc/profile`, `~/.profile`).

The daemon builds an explicit environment for each session (`build_vst_env`, `rust/vst-agents/src/context.rs`),
including a `PATH` that has the user's tool dirs (nvm, cargo, ...). `-l` throws that away in favor of what the
login files set up.

## Bug 1 — launch dies with `command not found`

**Where:** `rust/vst-routes/src/sessions.rs` (~L4632): when a plugin returns `use_shell: true`, the command is
`["sh", "-lc", shell_line]`.

**Why it fails:** `/etc/profile` on Debian (lines 5-9) unconditionally does
`PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games"`. The daemon's PATH is replaced. Only dirs re-added by
`~/.profile` survive (`~/.cargo/bin`, `~/.local/bin`). `~/.nvm/versions/node/*/bin` is added by `.bashrc`, which a
non-interactive `sh` never reads, so it's gone.

**Verified:** `which pi` → `~/.nvm/versions/node/v24.21.0/bin/pi`, but `sh -lc 'command -v pi'` → rc=127.

**Why earlier CLIs didn't hit it:** claude / agy install into `~/.local/bin` (survives the reset). pi and codex are
npm globals under nvm (don't). `use_shell: true` is set by pi, cursor, agy, codex and claude, so the path was always
shared; the install location is what differs. Also host-dependent: only hosts whose `/etc/profile` overwrites PATH
are affected, so it can pass on other machines.

**Not yet confirmed:** that vs-230's first launch failed exactly this way (inferred from the ~12s exit and the missing
pi session file; the pane output and exit code were not captured).

### Potential solutions

- **A (recommended): don't use a login shell.** Use `sh -c "exec <line>"`. The daemon already builds the env; `-l`
  adds nothing for agents. `exec` makes the pane process the agent itself, so exit status/`pane_current_command`
  reflect the agent rather than a wrapper shell. Shared-path fix: also repairs codex.
- **B: keep `-lc` but re-export PATH first:** `PATH='<daemon path>'; export PATH; exec <line>`. Only if something
  genuinely relies on login files (nothing known does).
- **C (defense in depth): resolve the binary up front.** Before spawning, check the plugin's binary is on the
  session PATH (`which`-style) and fail the create/resume with a clear error ("pi not found on PATH: ...") rather than
  letting the pane die silently as `exited`.
- **D: capture early-exit output.** If the tmux session dies within N seconds of launch, record the last pane
  output / exit code on the session so the UI can say why. Today an instant crash is indistinguishable from a normal exit.

## Bug 2 — Resume doesn't continue the work

**Where:** `rust/vst-agents/src/pi.rs` `get_restore_command` (~L198) and `capture_chat_id` (~L193);
consumer is `resume_spawn` in `rust/vst-routes/src/sessions.rs` (~L2759-2819).

**Mechanism:**
- `get_restore_command` always returns `Some(argv)` (falls back to the vst session id when there's no `agentChatId`).
- `resume_spawn` therefore always takes the restore branch; the fresh-launch branch that re-sends the initial prompt
  (`agent_chat_id.is_none() && initial_prompt.is_some()`) is unreachable for pi.
- `capture_chat_id` returns an id without checking it, so the resume "self-heal" step persists it as `agentChatId`,
  permanently disabling the prompt re-send.

**Evidence (vs-230 main session):** DB has `initialPrompt` set and `agentChatId = <session id>`, yet pi's session file
has no such message; first user message is one typed by hand.

**Contrast:** codex's `get_restore_command` (`codex.rs` ~L396) only returns `Some` if the id still has a rollout
on disk (`resumable_chat_id`), else `None` → fresh launch → prompt re-sent.

### Potential solutions

- **A (recommended): gate on real conversation state.** In pi: restore only if
  `~/.pi/agent/sessions/*/*_<id>.jsonl` exists **and contains a `"role":"user"` message** (the file is created at
  startup, before any message, so existence alone is not enough). Else return `None`. `capture_chat_id` returns
  `Some` only under the same check. `--session-id` makes the fresh launch reuse the same id, so nothing else changes.
- Depends on Bug 1 being fixed (the fresh-launch path uses the same spawn).

## omp (oh-my-pi) launch notes

**Where:** `rust/vst-agents/src/omp.rs`.

- **Header-only file:** `omp` writes a session `.jsonl` (title slot + header) at startup, before any message
  (`session/new` already creates the file). File existence is **not** proof a conversation began — `started_conversation`
  requires a `message` line with `role:"user"` (mirrors pi's gate, Decision 4).
- **Write lease / second writer:** a session is write-leased per id by one live process; a second writer appends
  `session_exit` to the **old** file and moves to a sibling file with a **new** id. `started_conversation` therefore
  orders by the filename timestamp, not mtime (Decision 6), and the tty→json toggle re-scans rather than trusting the
  stored id.
- **`--allow-home`:** `omp` refuses to operate on `$HOME`; the plugin always passes `--allow-home` and skips the
  `.gitignore` edit when `cwd` is `$HOME`. Store stays under `<cwd>/.vibe-station/omp-sessions/<sessionId>`.
- **`omp acp` `session/load` ignores `--session-dir`:** `session/new` writes into the pinned store, but load only scans
  omp's DEFAULT store (verified 18.12.6: `-32603 "ACP session not found"`), so any reconnect — the json→tty→json toggle,
  a daemon restart — would silently start a fresh conversation. Before each ACP connection the plugin symlinks the
  session file into `<default store>/vst-links/` (`link_into_default_store`); omp appends through the link, so the private
  store stays the only copy. A file symlink works, a directory symlink does NOT (probed). With `OMP_PROFILE`/a relocated
  agent dir the link lands in the wrong place and resume degrades to a fresh `session/new`.
- **Relocated omp store (known limitation):** `omp_default_sessions_root` knows `$PI_CODING_AGENT_DIR` and
  `~/.omp/agent/sessions` only. omp also relocates its sessions under `$XDG_DATA_HOME/omp/` and per-profile
  (`OMP_PROFILE`/`PI_PROFILE`) dirs; there the `vst-links` symlink lands where `session/load` never looks, so a
  reconnect starts a fresh conversation (the session layer falls back to `session/new`).
- **Forks minted by `omp acp` (known limitation):** when `omp acp` loads through a `vst-links` symlink, files it later
  mints itself (`/fork`, a contended second writer) become real files in `vst-links/`. History import follows them
  (it looks there), but resume/capture scan only the private store and keep the settled id.
- **Non-file backends:** omp's Redis/SQL session backends produce no `.jsonl`, so there is no id to resume/toggle on
  — unsupported (out of scope).
- **`bun` on PATH:** a bun/npm-installed `omp` is a `#!/usr/bin/env bun` script. The doctor `plugin-omp` check covers
  installing `omp` (`PLUGIN_OMP`: brew / curl / bun); the separate `omp-bun` check (`OMP_BUN`) warns when omp needs
  bun and it is missing from the daemon PATH. A native omp build (brew/curl) is not checked for bun.
- **Split terminal phase:** history import reads the ONE conversation whose id is the stored `agent_chat_id`. If a
  second writer or an in-TUI `/new` moved the terminal phase to a sibling file, only the settled conversation is
  imported; turns in the earlier file are not (documented limitation, same as resume following the newest file).

## General solution: make onboarding a checklist, not a discovery

The recurring theme is that each plugin re-implements launch/resume correctness by hand and the shared code trusts it.
Proposed hardening, in order of value:

1. **Fix the shared launch path (Bug 1 A)** so install location can't matter.
2. **Document the restore contract on the trait** (`plugin.rs`, `get_restore_command`): *must return `None` unless
   the CLI has a resumable conversation containing at least one user turn*. A plugin returning `Some` for an unstarted
   session is a bug.
3. **Enforce it centrally.** In `resume_spawn`, don't treat "restore command exists" as proof of a conversation:
   if the session has an `initial_prompt` and no user turn has been observed (e.g. no transcript / no captured
   message), fall back to the fresh-launch path. This removes the per-plugin footgun.
4. **Fail loudly on instant exit** (Bug 1 C + D) so the next unknown launch failure shows its reason in the UI
   instead of a bare `exited`.
5. **Add a shared plugin conformance test** run for every registered plugin: (a) launch argv/shell line resolves its
   binary under a *minimal* PATH (`/usr/bin:/bin` plus the daemon-provided dirs), (b) `get_restore_command` returns
   `None` for a fresh session with an initial prompt and no transcript, (c) `capture_chat_id` returns `None` before
   the first user turn.
6. **Onboarding checklist** (added to `docs/PLUGINS.md`): where does the CLI install (nvm/npm/cargo/brew)? does it need
   a ready signal or timeout fallback? when does it first persist a conversation? what does resume do on an empty one?
   verify with a real first launch on a clean host, not only the author's machine.

## Open questions

- Does codex actually fail the same way in a terminal session? (Same install location and `use_shell: true`;
  not tested.)
- Is anything relying on login-shell behavior (`~/.profile` env vars) for agent launches? If so, option B instead of A.
- The main pi session showed "Operation aborted" right after creating the subagent — probably an Esc in the TUI,
  unconfirmed and likely unrelated.
