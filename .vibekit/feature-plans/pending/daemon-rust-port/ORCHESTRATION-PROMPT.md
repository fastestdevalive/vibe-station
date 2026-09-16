<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Orchestration prompt: daemon-rust-port

> Paste this as the first message to a fresh session tasked with driving the Rust port end to end. You are the **planner/integrator** — this works with whichever agent/model you run it as (the loop is plain markdown + bash, no model-specific assumptions). You never write the Rust yourself — you write each part's brief, dispatch a **DeepSeek** subagent to implement it, gate its work, and move on. **DeepSeek is the default and first choice for every part.** The only permitted deviation is the time-boxed escalation ladder in step **D** below (active steering, then a Haiku-mode fallback) — never a routine substitution, and never silent.

## Your reference documents — read these first, in this order

1. `.vibekit/feature-plans/pending/daemon-rust-port/arch-daemon-rust-port.md` — the architecture. Every part's scope, dependencies, Gotchas, and the Phase recipe (steps 0-7) live here. **Do not re-derive any of this — cite it.**
2. `.vibekit/feature-plans/pending/daemon-rust-port/.sdlc-state.yaml` — which part is next, what's done.
3. `.claude/skills/rust-coding/SKILL.md` — the coding-standards skill every implementer session must load. You spot-check against it at gate time.
4. `AGENTS.md` (repo root) — the concurrency invariants (`withSessionLock`, two-axis status, PTY streams) the arch doc's Gotchas table cites throughout.

## Environment facts (verify, don't assume — they can drift)

```bash
echo "$VST_PROJECT $VST_WORKTREE $VST_SESSION"   # expect: vibe-station  vs-141  <your own session id>
vst worktree info "$VST_WORKTREE" --json          # confirm branch = port-daemon-rust
DEEPSEEK_MODE=$(vst mode ls --json | jq -r '.[] | select(.name=="deepseek") | .id')
echo "$DEEPSEEK_MODE"   # resolve by NAME every time, never hardcode the id — modes get recreated
```

- Resolved today as `mode-1785649772352-dlzo2` (cli: `opencode`, model: `deepseek-local/deepseek-v4-flash-0731`) — this is "DeepSeek v4 flash" from the arch doc. Don't hardcode it; re-resolve at the start of every session via the command above.
```bash
HAIKU_MODE=$(vst mode ls --json | jq -r '.[] | select(.name=="haiku") | .id')
if [ -z "$HAIKU_MODE" ]; then
  # No haiku mode exists yet — create it once, reuse thereafter. The exact flag for
  # pinning the model isn't confirmed here (vst mode add --help showed --name/--cli/
  # --context/--context-file/--preset, no bare --model) — check `vst mode add --help`
  # yourself and use whichever of --preset or --context-file actually pins model=haiku
  # on the `claude` cli before relying on this mode. Don't guess silently; verify once.
  vst mode add --name haiku --cli claude --preset haiku
  HAIKU_MODE=$(vst mode ls --json | jq -r '.[] | select(.name=="haiku") | .id')
fi
```
- **DeepSeek is the default for every part's IMPL step.** `$HAIKU_MODE` is a **time-boxed escalation fallback only** (step D) — never dispatched as a first attempt, and every use of it is something you report, not something you do silently.
- You run **in this same worktree** (`vs-141`) as your own session (`$VST_SESSION`). Every implementer you spawn is a **sibling session in this same worktree** (vst skill "Case B") — same branch, same checkout, no new worktree per part.

> **One-off model-swap exception #2 (2026-09-15b, user-directed — NOT a standing policy):** starting **after `07a` dispatch #4 (Group C)**, the default implementer switches to **`agy-medium`** (`mode-1784608587031-sd4sy`, cli `agy`, model "Gemini 3.5 Flash (Medium)" — resolve fresh via `vst mode ls --json | jq -r '.[] | select(.name=="agy-medium") | .id'`, don't hardcode). **Updated 2026-09-15c (user-directed):** the original plan reverted to `$DEEPSEEK_MODE` after `08-server-bootstrap`; the user has since extended agy-medium to **all remaining parts, including `09-cli-port` and `10-parity-cutover`** — do not revert to DeepSeek without a fresh, equally explicit instruction. As always, re-verify `agy-medium`'s mode id fresh at the start of each session rather than trusting either hardcoded id above.
> - **`agy` is terminal-only — it does not support the `--json` (Rich Chat) channel.** Every agy dispatch must **omit** `--json` from `vst session create` (plain tmux channel, the default) — passing `--json` to an agy-mode session is a dispatch-time bug, not a style choice. This is the opposite of the standing DeepSeek/Haiku preference (step C) — don't copy that flag onto an agy dispatch by habit.
> - Polling/steering an agy (tmux-channel) session works the same way as any tmux session (`vst session output` shows the terminal scrollback directly — no JSON-channel turn-boundary quirk like DeepSeek/Haiku's `waiting_for_human`-after-each-turn behavior, since tmux sessions don't have discrete "turns" the same way).
> - The gate/N6/invariant-verification rigor in steps E/F is unchanged — independently re-run the gate yourself regardless of which model implemented it.
> - **agy takes ~5-10s to actually start up after `vst session create` returns**, and its first action is an interactive permission prompt that blocks until answered. After dispatching, wait briefly, check `vst session output <id> --lines=30` for the prompt, and reply with `vst session send <id> "y" --wait` (or the tmux equivalent) before the dispatch is actually underway — do not treat "no progress yet" in the first ~15-20s as stuck, that's just the startup+prompt window.
> - **`vst session send <id> "..." --wait` had at least one delivery hiccup on an agy session** (message never reached the terminal, no error surfaced) — prefer `--no-wait` for agy/tmux dispatches and always verify with a follow-up `vst session output` check that the message actually appeared before assuming the session is stuck or acting on its (lack of) response.
> - **agy/tmux sessions tend to complete real work within a single short poll window** — poll on a tighter interval (e.g. ~8 min) than the ~15 min default used for DeepSeek/Haiku's JSON-channel turns.
> - **If you see agy running into a usage/rate limit mid-dispatch** (the terminal shows a limit/quota message), switch the model **within that same running session** using agy's own in-terminal `/model` slash command — send `/model gpt oss 120b` via `vst session send <id> "/model gpt oss 120b" --no-wait` (verify it lands, per the delivery-hiccup note above) rather than terminating and redispatching. This is a live fallback for hitting agy's own limit, distinct from the DeepSeek→Haiku escalation ladder in step D, and distinct from model-swap exception #2 itself.

## ⚠️ Never touch the user's LIVE `vst` daemon — this is a real incident, not a hypothetical

The user's own `vst-station` UI runs on a real daemon process (`~/.vibe-station/.daemon.lock`,
`~/.vibe-station/config.json`, default port `7421`) that is **shared across every worktree** —
it is not per-worktree, per-branch, or per-session. It is the daemon actually serving the
browser tab the user is looking at right now, including the session you (the orchestrator)
and every implementer you dispatch are running inside of.

During this session (2026-09-15), the user reported their live daemon got restarted while
this feature was in progress. A full transcript audit of the implementer session active at
the time found no direct evidence of it running the daemon, `vst daemon stop`, `pkill`, or
anything port/process-related — but the root cause was never conclusively identified, and
the risk becomes very real once `08-server-bootstrap` and `10-parity-cutover` start actually
building and running the `vst-daemon`/`vst-cli` binaries for smoke-testing or the parity
harness.

**Standing rule for every implementer dispatch from here forward, and especially for `08`
and `10`:**
- **Never run `vst daemon stop`/`restart`, `pkill`/`kill` against any daemon process, or any
  command that could plausibly affect a process outside this worktree's own `cargo`/`rust-gate.sh`
  invocations.** `cargo test`/`cargo check`/`rust-gate.sh` are always safe — they don't bind a
  real port or touch `~/.vibe-station/`. Actually *running* the built `vst-daemon` binary is the
  operation that's dangerous, not compiling or testing it.
- **Checked the actual TS source (`main.ts`) — there is NO home-directory override today.**
  `VST_HOME` is hardcoded to `join(homedir(), ".vibe-station")`; only the port is
  overridable (`VST_PORT` env var, read at `main.ts:177`). This means running the daemon
  binary bare on the host — Rust or the current Node one — always targets the SAME
  `~/.vibe-station/.daemon.lock`/`config.json` as the user's live daemon, regardless of
  port. The good news: `acquireLock()`'s PID-liveness check means a second instance
  **fails loud with "Daemon is already running (pid N). Use `vst daemon stop` first."
  rather than corrupting or replacing the live one** — treat that error as the CORRECT,
  safe outcome of an accidental bare-host run, not a bug to work around.
  **If a dispatch genuinely needs to run the built `vst-daemon` binary** (smoke test,
  `08`'s own verification, `10`'s parity harness): prefer the sanctioned, already-isolated
  path — `scripts/dev-sandbox.sh` / `docker-compose.dev.yml` (see AGENTS.md's "Docker dev
  sandboxes" section), which run in a container with its own `$HOME` and are the existing
  answer to this exact problem. Do not invent a bare-host workaround. If `08`'s or `10`'s
  own plan needs the Rust binary to support a home-dir override for testing purposes,
  that's a legitimate feature to design and add explicitly in that part's own scope — not
  something to assume already exists.
- **If you ever need to interact with the REAL running daemon for a legitimate reason** (e.g.
  checking something about your own session via `vst`), that's fine — `vst` CLI reads/writes to
  the real daemon by design, that's what it's for. The rule is about never *stopping, killing,
  or restarting* it, and never running a *second, competing* daemon instance against the same
  home/port.

## Step 0 — one-time, before the first phase

- [ ] If `.sdlc-state.yaml`'s `root` entry is still `awaiting_phase: plan` (not yet decomposed): run the formal review pass on the arch doc, then decompose into the 15 subfeature entries (`00-foundation` … `10-parity-cutover`, with `04` already split into `04-spike`/`04a`/`04b`/`04c` and `07` into `07a`/`07b`) and retire `root`. Do not skip this — it's the gate the arch doc itself requires before parts are drafted.
- [ ] Confirm `rust/` doesn't exist yet on disk (it shouldn't — part `00` creates it).

## The per-phase loop — repeat for every subfeature in dependency order

**A. Pick the next phase.** Read `current_subfeature` in `.sdlc-state.yaml`; if null/done, pick the next subfeature whose `Depends on` (Part Breakdown table) are all `mode: done`. `04-spike` is the one exception — **you**, the orchestrating agent, do that one directly, never dispatch it (the arch doc says so explicitly: it's the ACP transport-freezing spike, too high-stakes for a fresh weak-model session).

> **One-off parallel-dispatch exception (2026-09-15, user-directed — NOT a standing policy, never repeat this for any other part without an equally explicit user instruction):** `05-lifecycle-status` was dispatched to a Haiku sibling session **in parallel** with the in-flight `04c-json-agent-chat` DeepSeek session, since `05` depends only on `00/01/02/03` (not `04c`) and lives in an entirely separate crate (`vst-lifecycle` vs. `vst-agents`) — zero file overlap, so neither session can "fix" the other's work. The serial loop (this orchestrator, driving the DeepSeek line) does **not** pick up `05` after `04c` finishes — `.sdlc-state.yaml` will already show it `implementing`/`done` by the time you get there. After `04c`, skip straight to `06-ws-realtime`. Every part after `05` — including whatever `05` itself still needs (steering, gate, closeout) — goes back to the normal strictly-serial loop. Do not infer from this that parallel dispatch is now the default; it took an explicit user request this one time.

> **One-off model-swap exception (2026-09-15, user-directed — also NOT a standing policy):** the remainder of `04c-json-agent-chat` (its `JsonAgentSession` core, once unblocked by `05` finishing) is dispatched to `$HAIKU_MODE` instead of `$DEEPSEEK_MODE`, because Haiku delivered `05` well. **`06-ws-realtime` and every part after it reverts to `$DEEPSEEK_MODE` as the default implementer** — do not carry the Haiku default forward past `04c`.

> **One-off parallel-dispatch exception #2 (2026-09-15d, user-directed — NOT a standing policy, mirrors the `05`/`04c` precedent above):** `09-cli-port` was dispatched to an `agy-medium` sibling session **in parallel** with the in-flight `07b-rest-routes-misc` dispatch #2, since `09` depends only on `00` (the frozen `vst-types` contract, already `done`) and lives in an entirely separate crate (`vst-cli`, a bin crate with no shared source files with `vst-routes`) — zero file overlap. `09`'s dispatch prompt explicitly scopes it to `cli/src/*` → `rust/vst-cli` ONLY, forbids touching `vst-routes`/`vst-daemon` files, and reiterates the daemon-safety rule above (never run the built binary against the real `~/.vibe-station` home, `cargo check`/`cargo test` only). The serial loop does **not** pick up `09` again after `07b`/`08` finish if it's already `implementing`/`done` by then — check `.sdlc-state.yaml` before redispatching. Every part after `09` (`10-parity-cutover`) goes back to the normal strictly-serial loop. Do not infer from this that parallel dispatch is now the default; it took an explicit user request this one time, same as the `05`/`04c` precedent.

**B. Write a phase BRIEF, not a full plan — this is a deliberate token-budget decision, not a shortcut.**

> **Do NOT load the `planning` skill or use `_template_plan.md` for this feature's parts.** That template's CUJs, Architecture Diagram, Data Model, Alternatives-Considered sections exist to document things the arch doc *already owns* — restating them per part, across 15 parts, burns your own limited token budget for zero new information. The implementer session can read `arch-daemon-rust-port.md` itself; that's DeepSeek tokens, not yours, and that's the cheap side of this pipeline by design. Self-containment here is satisfied by **pointing at the arch doc's path**, not by copying its content — a real, deliberate deviation from the `planning` skill's usual self-containment bar, made explicit here so it doesn't read as an oversight later.

**Go slightly further than just filling the template — spend a few minutes actually skimming the TS source before writing "Part-specific notes":**
- Flag any file that merges multiple TS source files into one Rust module, or is unusually large (roughly >400-500 lines) relative to the rest of the part — that's a concrete complexity/risk signal, not a vague one (this is exactly what happened in `01-storage`'s `transcript.rs`: three TS files merged into 741 lines, which is where most of that part's time went).
- Flag any TS logic that's a retry/poll loop relying on an external async event (filesystem watch, chokidar callback) — call out explicitly that it needs an explicit bound (max attempts / `tokio::time::timeout`) in Rust, per `rust-coding` skill §9, not a literal `loop {}` translation.
- This is still a few sentences in "Part-specific notes," not new sections — the point is spending a small amount of your planning time now to prevent the implementer from burning a large amount of its time later discovering the same risk the hard way.

Write `<NN>/plan-<NN>-daemon-rust-port-<slug>.md` using **this exact minimal shape** (fill the brackets, nothing more):

```markdown
# Phase brief: <NN> — <slug>

**Read first:** arch-daemon-rust-port.md — Part Breakdown row `<NN>`, Entities & Modules row(s)
for `<crate>`, Gotchas #<list the specific numbers>, System Boundaries row(s) `<list>`.
**Skill:** load `rust-coding` before touching any .rs file.
**Crate(s):** rust/<crate-name>
**Depends on (already `done`):** <list>

## Files to port
<the file-map.tsv row for this part, or — before file-map.tsv exists — copy the Part
Breakdown table's "Scope" column verbatim for this part>

## Checklist (Phase recipe steps 0-6 live in the arch doc — cite, do not restate them)
- [ ] 0. Load rust-coding skill
- [ ] 1. Read the files above + the named AGENTS.md sections + Gotchas rows
- [ ] 2. Write the behavior contract (bullets)
- [ ] 3. Write Rust tests first; `git commit -m "test(<NN>): behavior contract"`
- [ ] 4. Implement (this crate only; vst-types amendment rule if needed; never touch
        rust/Cargo.toml's [workspace] table, [profile.release], or the CI workflow — N6)
- [ ] 5. Run rust/scripts/rust-gate.sh <crate>; save log to rust/.gate/<NN>.log; commit
- [ ] 6. Report: what's ported, what's `#[ignore]`d + why, any vst-types amendments — STOP

## Part-specific notes
<ONLY what's genuinely unique to this part beyond the arch doc — most parts need nothing
here. Example (04b only): "AcpTransport trait signature is frozen by 04-spike at
rust/vst-agents/src/acp_transport.rs — implement against it, do not redesign it.">
```

- That's the whole plan file — expect ~30-40 lines, not a multi-page document. If you find yourself writing more than the "Part-specific notes" section needs, stop — you're re-deriving the arch doc, which is exactly what this format exists to prevent.
- **Self-check it yourself before dispatching** (does it point at the right rows, is the file list right) — skip a separate sdlc reviewer-agent pass for this feature's phase briefs specifically; a 30-line brief doesn't need a second model's review round-trip, and that's another cost this pipeline doesn't need to pay.

**C. Dispatch the implementer.**
```bash
vst session create "$VST_WORKTREE" --type=agent --mode="$DEEPSEEK_MODE" --json \
  --prompt="Implement .vibekit/feature-plans/pending/daemon-rust-port/<NN>/plan-<NN>-daemon-rust-port-<slug>.md in full. Load the rust-coding skill before writing any .rs file. Follow the plan's checklist exactly, in order. When you reach the plan's REPORT step, stop — do not start any other part's crate."
```
- **DeepSeek implementer sessions always use `--json` (the Rich Chat / JSON agent-chat channel), never plain tmux.** This is a deliberate, standing preference — don't drop the flag on later dispatches or on the Haiku fallback below.
- Capture the returned session id. This session is **fire-and-forget** — it is not a Claude Code subagent you get a task-notification from; it's a separate CLI process. You must poll it.
- Update `.sdlc-state.yaml`: this subfeature's `mode: implementing`.

**D. Poll for completion — 30-minute time box, with a real escalation ladder. No phase gets longer than this without you actively doing something about it.**

```bash
vst session info <implementer-id> --json   # check .state
vst session output <implementer-id> --lines=80   # spot-check progress
```

- Check roughly every 10-15 minutes, not continuously. Track wall-clock time since dispatch (step C) yourself — a session sitting at `working` is not evidence it's fine.
- **At the 30-minute mark, if the part hasn't reached REPORT yet:** read its output in full (not just the last 80 lines — scroll back far enough to see whether it's making forward progress or repeating itself), and act:
  - **Progress is real** (new files, new passing tests, moving through the checklist) but the part is just genuinely large → let it continue, re-check at the next 15-minute interval. Don't escalate work that's legitimately still going.
  - **It's stuck** — the same compiler error message (or class of error) recurring across multiple rebuild attempts, a test that's been "running" for 60+ seconds with no result, or no new commits since the last check → **actively steer**: read enough of the actual error/output yourself to identify the concrete fix (see `rust-coding` skill §8/§9 for the two patterns already known to cause exactly this), then `vst session send <implementer-id> "<the specific diagnosis and fix, not a generic 'please continue'>" --wait`. One steering attempt.
  - **Steering didn't unstick it within the next 15-30 minutes** (still the same symptom, no new commits) → **escalate to the Haiku fallback**: `vst session terminate <implementer-id>`, then dispatch a fresh session on `$HAIKU_MODE` (same `--json` channel — see step C's standing preference) with the **same phase brief** (the work already committed to git is preserved — a fresh session picks up from the current on-disk/committed state, it does not restart from zero; append one line to the dispatch prompt naming the specific thing that was stuck, so the fallback session doesn't rediscover it). Record this in `.sdlc-state.yaml`'s `handoff` fields for this subfeature and note it in your final report — this is a real event to surface, not something to smooth over.
- **Total time budget per phase is a soft ~60-90 minutes** (30 min initial + one steering round + the fallback dispatch) before you stop and flag the phase to the human instead of continuing to spend cycles on it — same as step G's "2 failed rounds" rule, applied here to stuck-in-flight work rather than only post-gate failures.

**E. Gate — two checks, both required.**
1. **Full tests passing:** run `rust/scripts/rust-gate.sh <this part's crate(s)>` **yourself** (don't trust the implementer's own `rust/.gate/<part>.log` claim — re-run it). This one script already bundles `cargo fmt --check` + `cargo clippy` + `cargo test`, so "tests passing" here means the whole gate is green, not just `cargo test` in isolation. Also run `cargo test -p vst-types` (wire fixtures still round-trip).
2. **Sanity review of the test file(s):** read the `tests/` (or `#[cfg(test)]`) diff for this part. You're checking: do these tests actually exercise real behavior (the ones named in the arch doc's Gotchas table especially), or were they weakened/stubbed to get green? Cross-check against `git diff <test-commit>..HEAD -- rust/<crate>/tests` being empty (per the plan's own commit-boundary rule) — a non-empty diff there is an automatic fail, not something to wave through.
3. **For every part after `00`:** `git diff --stat <part-start>..HEAD -- rust/Cargo.toml .github/workflows/rust-ci.yml` must be empty. Part `00` scaffolds every crate and the workspace/CI config once, permanently (N6) — any later part touching these is an automatic fail, no amendment rule applies here (unlike `vst-types`).
- Both pass → go to F. Either fails → go to G.

**F. Phase done.**
- [ ] Mark the plan's checklist items `[x]`.
- [ ] Update `.sdlc-state.yaml`: `mode: done`, record the commit hash.
- [ ] Terminate the implementer session: `vst session terminate <implementer-id>` (safe here — it's a sibling you created, not your own session, so no promotion side-effect).
- [ ] Commit the work on this worktree's branch.
- [ ] Go back to **A**.

**G. Gate failed.**
- First failure: send corrective feedback to the **same** session (it keeps its context — cheaper and more likely to succeed than a fresh one): `vst session send <implementer-id> "<specific failure: which test/clippy/lint, why>" --wait`, then re-run **E**.
- Second failure on the same part: same escalation as step D's ladder — terminate and retry once on `$HAIKU_MODE` with the same phase brief plus a note on what's already failed twice.
- After that (3 total attempts, mixed models): stop dispatching further rounds. Do not loop indefinitely. Either replan the part (M4-style — supersede the plan, note why) or surface it to the human and wait. Never silently weaken the gate to get past a stuck part.

## Stop conditions

- All 15 subfeatures `mode: done` → the port's implementation is complete. Do **not** run part `10`'s deletion of the old `daemon/`+`cli/` TS trees without explicit human confirmation first — that step is destructive and irreversible on this branch.
- Any part fails its gate twice in a row → stop and escalate (see G) rather than continuing to the next part on a broken foundation.
