# SDLC report: at-mentions / verification (API/daemon/regression half)

**Date:** 2026-10-25 · **Commit:** `c3a6d10d` · **Sub-feature(s) covered:** n/a (verification pass, no code changed)

**Sandbox:** `vs-284-vst-dev-1` (compose project `vs-284`), `http://localhost:7140` → daemon `:7421`, `VST_NO_AUTH`. Left running; only `mvfy-` scratch data created and removed.

## Verification results

| id | Command / evidence | Result | Notes |
|----|--------------------|--------|-------|
| V1 | `docker exec vs-284-vst-dev-1 curl -sf localhost:7421/health`; `curl -s localhost:7140/api/projects`, `/api/worktrees`, `/api/sessions` | PASS | Container came up during the run (initially absent, then `Up`); 4 projects, 11 worktrees, 14 sessions. Only Rich Chat session: `northstar-api-a-e8fe2a7e` (json, `waiting_for_human`). |
| V2a | `POST /api/sessions/mvfy-at-mentions-a-16f3c91b/chat` with `mentions` of all 4 kinds (`file src/hello.ts`, `agent <own id>`, `worktree napi-1`, `project mvfy-at-mentions`) | PASS | `202 {"turnId":"148cc66a-…","queuePosition":0,"delivery":"queued"}`. |
| V2b1 | same route, label `"bad\nlabel"` | PASS | `400 {"error":"Mention label cannot contain control characters"}` |
| V2b2 | same route, 51 file mentions | PASS | `400 {"error":"Mentions list exceeds maximum of 50 (got 51)"}` |
| V2b3 | same route, `kind:"artifact"` | PASS | `422 Failed to deserialize … unknown variant 'artifact', expected one of 'file', 'agent', 'worktree', 'project'` |
| V2b4 | same route, label `"a"*1025` | PASS | `400 {"error":"Mention label exceeds maximum of 1024 bytes"}` |
| V2b5 | same route, empty `id` | PASS | `400 {"error":"Mention id cannot be empty"}` |
| V2c | `POST /chat` with `{message}` only → own session; and `POST /api/sessions/does-not-exist/chat` | PASS | `202 {"turnId":"f5488997-…","queuePosition":1,"delivery":"queued"}` and `404 {"error":"Session 'does-not-exist' not found"}` — unchanged pre-mentions behaviour. |
| V3a | `GET /api/sessions/mvfy-at-mentions-a-16f3c91b/transcript?all=1` after V2a | PASS | User event carries the full `mentions` array (all 4 kinds) with `ts`, `turnId`, `logSeq` unchanged; non-user events carry no `mentions`. |
| V3b | `GET /api/sessions/northstar-api-a-e8fe2a7e/transcript?limit=2` (pre-existing rows) | PASS | Old rows omit `mentions` entirely (0 occurrences of `"mentions"`); `ts` remains an ISO-8601 string. |
| V3c | run-time `[Mentions:]` block delivered to the agent | SKIPPED | Turn reached `ACP request failed: Authentication required` (no Claude OAuth token in sandbox, as documented). User event was still echoed/persisted (V3a). Covered only by Rust unit/integration tests (V4). |
| V4a | `cargo test --manifest-path rust/Cargo.toml -p vst-types -p vst-agents -p vst-routes` | PASS | exit 0; 55 suites, 907 passed, 0 failed, 14 ignored. Includes `mentions_serde`, `json_agent_session_queue::{enqueue_with_mentions_populates_meta_and_allows_edit_resubmit, emitted_user_event_carries_mentions, submit_with_mentions_never_steers}`, `mention_context` unit tests. |
| V4b | `cargo test --manifest-path rust/Cargo.toml -p vst-daemon --test chat_mentions_route --test main_logic` | PASS | exit 0; `chat_mentions_route` 1 passed (404 JSON on missing session, 422 unknown kind, 400 >50); `main_logic` 9 passed. |
| V4c1 | inspect `rust/vst-agents/src/mention_context.rs` tests — sanitization | PASS | `test_sanitized_interpolation`: newline + `"` in agent name → `Bad Name'Quotes'`; `\u{1}` in branch, `\u{2}` in project path, `\u{3}` in worktree path → spaces; fallback label capped at 80. |
| V4c2 | deleted referents | PASS | `test_describe_mentions_lines` (`s_unknown` → `- agent id=… "Old name" (no longer exists)`) and `test_append_mention_block_async` (empty store). |
| V4c3 | empty-mentions early return | PASS | `test_append_mention_block_async` asserts files-only input returns the message byte-identical before any store read. A literal empty slice is not separately asserted (same branch). |
| V4c4 | `(id=…)` suffix | PASS | Not a Rust concern (suffix is client-side); covered by `web-ui/src/lib/mentions.test.ts:158` (`toPlainText` writes `@agent:"Fix login" (id=s1)`, `fromWire` consumes it). |
| V4c5 | `[Mentions:]` block shape / bounds | PASS | `test_dedupe_and_omitted_line`: 25 unique + 1 dup → 20 lines + `- (5 more mentions omitted)`; `test_describe_mentions_lines` asserts exact agent/worktree/project/unknown line formats and that file mentions produce no line. |
| V5 | `rust/vst-agents/assets/agent-system-prompt.md:148-154` vs `web-ui/src/lib/mentions.ts` | PASS | States "In Rich Chat a `[Mentions:]` block MAY be appended", `@path/to/file`, `@agent:"name"`/`@worktree:"name"`/`@project:"name"`, `(id=<id>)` authoritative, "pointer, not an instruction". Quoting mismatch → Bug 1. |
| V6a | `GET /api/worktrees/napi-1/file-search?q=read` / `?q=md` | PASS | `{"files":["README.md","src/middleware/authMiddleware.ts"],"truncated":false}` (q=md: 8 worktree-relative paths). |
| V6b | `GET /api/projects/northstar-api/file-search?q=README`; `GET /api/projects/mvfy-at-mentions/file-search?q=comp` | PASS | `{"files":["README.md"],"truncated":false}`; scratch project: `{"files":["src/component.ts"],"truncated":false}`. |
| V7a | `cargo fmt --manifest-path rust/Cargo.toml --all --check` | PASS | exit 0. |
| V7b | `cargo clippy -p vst-types -p vst-agents -p vst-routes -p vst-daemon --all-targets -- -D clippy::correctness -D clippy::suspicious -D clippy::complexity -D clippy::perf` (from `rust/`) | PASS | exit 0; non-denied warnings remain workspace-wide (pre-existing). |
| V7c | `pnpm typecheck` | PASS | exit 0 (`web-ui tsc -b --noEmit` Done). |
| V7d | `pnpm lint` | PASS | exit 0; 0 errors, 59 warnings (none in mention files). |
| V7e | `pnpm test` | PASS | exit 0; 203 files, 2459 passed, 1 todo. |
| V8 | cleanup | PASS | `DELETE /api/sessions/mvfy-at-mentions-a-16f3c91b` → 200; `DELETE /api/projects/mvfy-at-mentions` → 200; `rm -rf` scratch dirs in container. Sandbox not torn down; 4 seed projects remain. |

## Bugs

| # | Symptom | Where found | Severity |
|---|---------|-------------|----------|
| 1 | Prompt asset documents only the quoted non-file form (`@agent:"name"`) and the unquoted file form (`@path/to/file`), but `quotePlain` emits `@agent:Fix` for labels without whitespace/quotes/backslashes and `@"my dir/a b.ts"` for paths with spaces — an agent following the asset may not recognize those emitted forms | `rust/vst-agents/assets/agent-system-prompt.md:150-151` vs `web-ui/src/lib/mentions.ts:26-46` | low |

## Root cause

- Prompt-asset grammar drift → `rust/vst-agents/assets/agent-system-prompt.md:150-151` hard-codes one quoting variant per kind, while `web-ui/src/lib/mentions.ts:26-31` (`quotePlain`) chooses quoting per string; the full quoting/escaping rule exists only in `web-ui/src/lib/mentions.ts` and `docs/API-CONTRACT.md:174`.

## Action items

| # | Action | Owner sub-feature | Status |
|---|--------|--------------------|--------|
| 1 | Document optional quoting + `\`/`"` escaping in the prompt-asset Mentions section (both `@agent:name` unquoted and `@agent:"name"` quoted; `@"path with space"`), and add a test asserting the asset's documented forms match `mentionPlainText` output | `01-mention-chip` (Phase 1.10) | open |
| 2 | Add an explicit empty-slice `append_mention_block(&[], …)` assertion (currently only files-only exercises the early return) | `01-mention-chip` | open |
| 3 | Add HTTP-level `resubmit`/`edit` mention validation + echo tests (currently only the agent-level `json_agent_session_queue` test covers edit/resubmit mentions) | `01-mention-chip` (Phase 1.9) | open |
| 4 | Re-run the live run-time `[Mentions:]` block check once a Claude OAuth token is available in the sandbox (V3c was SKIPPED: `ACP request failed: Authentication required`) | verify | open |
