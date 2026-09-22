<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: agy `list_models()` — live query instead of stale hardcoded list

> `AGY_MODELS` (`rust/vst-agents/src/agy.rs:44-51`) is a stale hardcoded const (still lists
> "Gemini 3.5 Flash", which `agy models` no longer even returns). Replace with a live
> `agy models` subprocess query, mirroring `opencode.rs`'s existing `list_models()` pattern
> exactly (`rust/vst-agents/src/opencode.rs:394-457`). No interface change — `list_models()`
> is already a required `AgentPlugin` trait method (`plugin.rs:272`).

**Branch:** `acp-even-itnegration` (new commit, not squashed into the agy-acp commit) · **Status:** Implemented
**Scope:** small, single-function fix. No PRD (no user-facing behavior decision — same picker, fresher data).

---

## Concept

- `agy models` prints one model per line, tab-separated: `<id>\t<display-name>` (verified live against
  a real authenticated `agy` — 14 current models, none of which match the stale `AGY_MODELS` const).
- `agy` accepts the **display-name** column directly as `--model "<name>"` (verified:
  `agy --model "Gemini 3.1 Pro (High)" -p "..."` works) — so the display name is what `list_models()`
  must return, matching the existing hardcoded const's format and every existing caller's expectation.
- Each line (including every Low/Medium/High reasoning-effort variant) is its OWN flat model string —
  no grouping/expansion. Same flat-`Vec<String>`-with-baked-in-variant convention every other plugin
  already uses (e.g. claude's `"sonnet[1m]"` vs `"sonnet"`).
- Parsing logic factored into a pure, unit-testable function (`parse_agy_models_output`) — `opencode`'s
  equivalent has zero test coverage for its parse step; this one gets a real unit test instead.

```
list_models() ──spawn──► `agy models` (15s timeout) ──stdout──► parse_agy_models_output()
                                                                        │
                                                          split tab, col 2, skip header/blank
                                                                        ▼
                                                          ListModelsResult { models, error }
```

## Out of scope

- `AGY_DEFAULT_MODEL` const — left as-is (`"Gemini 3.1 Pro (High)"` is still a valid, current model per
  the live output; not stale, no reason to touch it).
- `session/setConfigOption` / ACP model-selection wiring — unaffected, still receives whatever string
  `list_models()` returns.
- Any UI grouping/collapsing of Low/Medium/High — explicitly not wanted (see report's "how do you tackle
  low/medium/high" Q&A); each stays a separate flat entry.

---

## Checklist

- [x] 1.1 Add `parse_agy_models_output(stdout: &str) -> Vec<String>` (pure fn) to `agy.rs`: split lines,
      split each on first `\t`, take column 2 trimmed, skip empty/header lines (`"Fetching available
      models..."` has no tab — naturally filtered by requiring a tab split to succeed)
- [x] 1.2 Rewrite `list_models()` (`agy.rs:402-409`) to shell out to `agy models` with a 15s timeout,
      mirroring `opencode.rs:394-457`'s success/non-zero-exit/spawn-error/timeout branches and its
      `[cli-models]` eprintln diagnostic prefix, feeding successful stdout through `parse_agy_models_output`
- [x] 1.3 Keep `AGY_MODELS`/`AGY_DEFAULT_MODEL` consts — `AGY_DEFAULT_MODEL` still used as the pre-fetch
      default; decide whether `AGY_MODELS` is still referenced anywhere else before removing it
- [x] 1.4 Unit test `parse_agy_models_output` in `tests/agy.rs`: real captured `agy models` output
      (including the non-tab "Fetching..." header line) → expect the 14 display names, header excluded
- [x] 1.5 `cargo build -p vst-agents`, `cargo test -p vst-agents`, `cargo clippy -p vst-agents --all-targets
      --all-features -- -D clippy::correctness -D clippy::suspicious -D clippy::complexity -D clippy::perf`
      all clean
- [x] 1.6 Commit as its own commit on `acp-even-itnegration` (not squashed into the agy-acp commit)

## Reference files

| Item | Path |
|------|------|
| Target | `rust/vst-agents/src/agy.rs:44-51` (`AGY_MODELS`), `:402-409` (`list_models`) |
| Pattern to mirror | `rust/vst-agents/src/opencode.rs:394-457` |
| Trait (unchanged) | `rust/vst-agents/src/plugin.rs:272` (`fn list_models` — already required) |
| Tests | `rust/vst-agents/tests/agy.rs` |
