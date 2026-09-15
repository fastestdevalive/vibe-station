<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Orchestration prompt: daemon-rust-port

> Paste this as the first message to a fresh session tasked with driving the Rust port end to end. You are the **planner/integrator** — this works with whichever agent/model you run it as (the loop is plain markdown + bash, no model-specific assumptions). You never write the Rust yourself — you write each part's brief, dispatch a **DeepSeek** subagent to implement it, gate its work, and move on. **Implementation is DeepSeek-only, every part, no exceptions or fallbacks to another model.**

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
- Implementation is **DeepSeek-only** for every part — no other mode is dispatched for the IMPL step, regardless of repeated gate failures (see step G's escalation path instead of switching models).
- You run **in this same worktree** (`vs-141`) as your own session (`$VST_SESSION`). Every implementer you spawn is a **sibling session in this same worktree** (vst skill "Case B") — same branch, same checkout, no new worktree per part.

## Step 0 — one-time, before the first phase

- [ ] If `.sdlc-state.yaml`'s `root` entry is still `awaiting_phase: plan` (not yet decomposed): run the formal review pass on the arch doc, then decompose into the 15 subfeature entries (`00-foundation` … `10-parity-cutover`, with `04` already split into `04-spike`/`04a`/`04b`/`04c` and `07` into `07a`/`07b`) and retire `root`. Do not skip this — it's the gate the arch doc itself requires before parts are drafted.
- [ ] Confirm `rust/` doesn't exist yet on disk (it shouldn't — part `00` creates it).

## The per-phase loop — repeat for every subfeature in dependency order

**A. Pick the next phase.** Read `current_subfeature` in `.sdlc-state.yaml`; if null/done, pick the next subfeature whose `Depends on` (Part Breakdown table) are all `mode: done`. `04-spike` is the one exception — **you**, the orchestrating agent, do that one directly, never dispatch it (the arch doc says so explicitly: it's the ACP transport-freezing spike, too high-stakes for a fresh weak-model session).

**B. Write a phase BRIEF, not a full plan — this is a deliberate token-budget decision, not a shortcut.**

> **Do NOT load the `planning` skill or use `_template_plan.md` for this feature's parts.** That template's CUJs, Architecture Diagram, Data Model, Alternatives-Considered sections exist to document things the arch doc *already owns* — restating them per part, across 15 parts, burns your own limited token budget for zero new information. The implementer session can read `arch-daemon-rust-port.md` itself; that's DeepSeek tokens, not yours, and that's the cheap side of this pipeline by design. Self-containment here is satisfied by **pointing at the arch doc's path**, not by copying its content — a real, deliberate deviation from the `planning` skill's usual self-containment bar, made explicit here so it doesn't read as an oversight later.

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
vst session create "$VST_WORKTREE" --type=agent --mode="$DEEPSEEK_MODE" \
  --prompt="Implement .vibekit/feature-plans/pending/daemon-rust-port/<NN>/plan-<NN>-daemon-rust-port-<slug>.md in full. Load the rust-coding skill before writing any .rs file. Follow the plan's checklist exactly, in order. When you reach the plan's REPORT step, stop — do not start any other part's crate."
```
- Capture the returned session id. This session is **fire-and-forget** — it is not a Claude Code subagent you get a task-notification from; it's a separate CLI process. You must poll it.
- Update `.sdlc-state.yaml`: this subfeature's `mode: implementing`.

**D. Poll for completion — don't busy-loop.**
```bash
vst session info <implementer-id> --json   # check .state
vst session output <implementer-id> --lines=80   # spot-check progress
```
- Check every few minutes, not continuously. A session that's `idle` after having been `working` has finished its turn — read its output to see whether it reached REPORT or stalled/errored.

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
- After 2 failed rounds on the same part: stop dispatching further rounds. Do not loop indefinitely. Either replan the part (M4-style — supersede the plan, note why) or surface it to the human and wait. Never silently weaken the gate to get past a stuck part.

## Stop conditions

- All 15 subfeatures `mode: done` → the port's implementation is complete. Do **not** run part `10`'s deletion of the old `daemon/`+`cli/` TS trees without explicit human confirmation first — that step is destructive and irreversible on this branch.
- Any part fails its gate twice in a row → stop and escalate (see G) rather than continuing to the next part on a broken foundation.
