# SDLC report: opencode tty→json toggle — Rich Chat empty on first toggle, then "syncs"

**Date:** 2026-09-22 · **Commit:** `35b5c00` (branch `acp-even-itnegration`, uncommitted agy-acp edits untouched/unrelated) · **Sub-feature(s) covered:** none — standalone bug report, no code changes · **Method:** code trace + live reproduction against sandbox `vs-165-vst-dev-1` (opencode `1.18.32`, mode `mode-1790098302144-fc9b1`, session `forge-cli-a-ea938f45`, both left in place)

## Bugs
| # | Symptom | Where found | Severity |
|---|---------|-------------|----------|
| B1 | opencode session started on the **terminal** channel never gets `agentChatId` — stays `NULL` in `vibe-station.db` for the whole tty phase, even after a full user/assistant turn | live sandbox: `GET /api/sessions/:id` + `sessions.agentChatId` row after `TERMINAL-PHASE-MSG-1` was answered (native `ses_f35d371a2ffe…` had 4 messages) | high — root of B2–B4 |
| B2 | First tty→json toggle: Rich Chat is **empty** (`GET …/transcript?all=1` → `count=0`) yet `PATCH …/channel` replies `"historyImported":true` | live sandbox, step 2 of the user's sequence | high — user-visible, misleading flag |
| B3 | First Rich Chat turn mints a **brand-new native opencode session** (`ses_f35d20a98ffe…`) instead of continuing the terminal one (`ses_f35d371a2ffe…`); the record is then stamped `agentChatId = acpSessionId = ses_f35d20a98ffe…` | live sandbox, step 3; `SELECT id,count(*) FROM session/message` in `opencode.db` shows two separate sessions | high — terminal-phase conversation is orphaned permanently |
| B4 | json→tty resumes `opencode -m … --session ses_f35d20a98ffe…` (the Rich-Chat-minted id) — terminal shows only the Rich Chat turn; every later toggle imports correctly (2nd json toggle backfilled `TERMINAL-PHASE-MSG-3`/`gamma` as seq 5–7) → the "then it syncs" half of the report | live sandbox, steps 4–5; `ps -eo args \| grep opencode` in the pane | high — exactly the user's report |
| B5 | The opencode recorder plugin (`opencode.rs:216-229`, `.opencode/plugins/vst-recorder.ts`) uses a top-level `"session.created"` hook key that opencode `1.18.32` **never invokes**; only the generic `event` hook delivers `event.type === "session.created"` — so even where the plugin IS installed, no token file is ever written | live sandbox: probe plugin logging both hook shapes → `hook session.created` never logged, `event session.created` logged after the first message; `.opencode/plugins/` (plural) IS loaded (`plugin-loaded dir=…` line) | high — kills the only tty-phase chat-id channel opencode has |
| B6 | Fresh tty create (`spawn_session`, `sessions.rs:4194`) never calls `setup_workspace_hooks` nor `capture_chat_id` — the TS original did both (`spawn.ts:516-519` hooks pre-spawn, `spawn.ts:597-598`/`678-679` "Step 7.5" capture post-ready). Only `/resume` (`:2563`,`:2599`) and json→tty (`:3507`,`:3542`) have them | code: `grep setup_workspace_hooks\|capture_chat_id vst-routes/src/sessions.rs`; sandbox: no `.opencode/plugins/` under `forge-cli` after create | high — Rust-port regression, independent of B5 |
| B7 | tty→json branch (`sessions.rs:3696-3716`) only calls `refresh_chat_id_on_toggle`, which opencode does not implement (default `None`, `plugin.rs:267`) — no `capture_chat_id` self-heal on this direction, so a token file that DID exist would still be ignored at the moment the importer needs it | code | medium — third independent gap on the same id |
| B8 | REST `serialize_session` (`sessions.rs:170`) does not expose `agentChatId`/`acpSessionId` — a client cannot see B1 without reading `vibe-station.db` | code + `GET /api/sessions/:id` | low — diagnosability only |

- Not previously documented: `.vibekit/reports/`, `.vibekit/feature-plans/`, `docs/` have no match for this symptom; `docs/AGENT-CHAT-ID-CAPTURE.md:155-170` and `docs/JSON-CHAT-ARCHITECTURE.md:20` still describe the TS-era behaviour (hook fires, capture polls 30s after spawn) as if live
- The ACP plan's spike 3.0b (`plan-01-acp-migration-core-plugins.md:676`) was supposed to "prove whether the `session.created` hook fires"; its Spike Results row (`:457`) records the id-space verdict but `n/a` for the hook — the hook check was never actually done

## Root cause
- `no-native-id-at-toggle` → `json_agent_session/mod.rs:563` → `import_native_history` returns `None` the instant `session.agent_chat_id` is `None`; the importer never runs, no watermark is written, and the route (`sessions.rs:3799-3802`) still sets `history_imported = true` because it only checks `has_native_history_importer(cli)`, not the outcome
- `why-the-id-is-None` → three stacked gaps, any one of which alone would produce B1: (a) `opencode.rs:216-229` recorder hook shape is dead under opencode 1.18.x (B5); (b) `sessions.rs:4194` fresh-create spawn dropped the TS `setupWorkspaceHooks` + Step-7.5 `captureChatId` (B6); (c) `sessions.rs:3696-3716` tty→json has no `capture_chat_id` self-heal (B7)
- `new-chat-created` → `json_agent_session/connection.rs:75-81,119-121` → `prior_acp_id = acp_session_id.or(agent_chat_id)` is `None` → `session/new`, not `session/load`; `opencode.rs:552-563` `first_turn_session_init` then writes the new ACP id into `agent_chat_id` (Decision 6 Option A, ids coincide) — correct behaviour given a missing id, which is why it "self-heals": from that turn on both channels share one native id
- `terminal-shows-only-rich-chat-turn` → `opencode.rs:489-507` `get_restore_command` → `--session <agent_chat_id>` = the Rich-Chat-minted id; the original terminal session id is referenced by nothing and is unrecoverable from vst's records
- Not a watermark bug: `opencode_import.rs:69-72` starts at `-1` on first run and the second run imported the post-toggle turn correctly; not a race: the native db already held the terminal turn (4 rows) before the toggle

## Action items
| # | Action | Owner sub-feature | Status |
|---|--------|--------------------|--------|
| A1 | Fix the recorder plugin (`opencode.rs:216-229`): register via the generic `event` hook and branch on `event.type === "session.created"`, reading `event.properties.info.id`; keep `VST_SPAWN_TOKEN` gating. Verified shape in sandbox writes `.vibe-station/agent-chat-ids/<token>` after the first message | new bundle (`opencode-tty-chat-id`) | open |
| A2 | Restore TS parity in `spawn_session` (`sessions.rs:4194`): call `plugin.setup_workspace_hooks(&cwd)` pre-spawn and `plugin.capture_chat_id(...)` post-ready when `agent_chat_id.is_none()`; return the captured id so `run_agent_spawn_job`/`run_direct_agent_spawn_job` (`:1130-1158`) persist it alongside the spawn state (today they persist only lifecycle). Note `session: &SessionRecord` is immutable there (`:4219-4223` comment) — thread the id back via the return value | same bundle | open |
| A3 | tty→json toggle (`sessions.rs:3696-3716`): after `refresh_chat_id_on_toggle`, if `agent_chat_id` is still `None`, run `plugin.capture_chat_id` (bounded — opencode's poll is 30s; the token file already exists at this point so it returns immediately; for CLIs without a file it should time out fast or be skipped via the existing `refresh` contract) before persisting and before `import_native_history` | same bundle | open |
| A4 | `sessions.rs:3799-3802`: derive `history_imported` from the `ImportOutcome` (`turns_imported > 0` or at least `Some(_)`), not from `has_native_history_importer(cli)` | same bundle | open |
| A5 | Regression test: tty create → one turn → toggle json → assert transcript non-empty and `agent_chat_id` equals the native id seen in the tty phase; mock plugin must exercise `capture_chat_id` on the create path (TS had `spawn.test.ts` "1.T3 — captureChatId result sets session.agentChatId after spawn"; no Rust equivalent exists) | same bundle | open |
| A6 | Docs: update `docs/AGENT-CHAT-ID-CAPTURE.md` § opencode and `docs/JSON-CHAT-ARCHITECTURE.md:20` to the `event`-hook shape and to state that capture happens at create AND on both toggle directions; fill the spike 3.0b hook column | same bundle | open |
| A7 | Optional: expose `agentChatId` in `serialize_session` (`sessions.rs:170`) so the UI/CLI can surface "no native id yet" instead of a silent empty Rich Chat | new bundle or same | open |
| A8 | Not checked: whether opencode's ACP `session/load` (`connection.rs:97-116`) actually restores a tty-created session's context once A1–A3 give it the right id (spike 3.0b only proved `opencode run --session` recall); claude is affected by B6/B7 too but its hook (`claude.rs:80-95`) fires at TUI start so the token file exists by the time `/resume` or json→tty self-heals — verify the tty→json direction for claude separately | new bundle | open |

## Diagrams
```mermaid
sequenceDiagram
    participant U as user
    participant R as sessions.rs
    participant OC as opencode TUI / acp
    participant DB as opencode.db
    U->>R: POST /sessions channel=tmux
    R->>OC: spawn_session (no hooks, no capture) [B6]
    U->>OC: TERMINAL-PHASE-MSG-1
    OC->>DB: session S1 (alpha)
    Note over R: agent_chat_id = None [B1,B5]
    U->>R: PATCH channel=json
    R->>R: refresh_chat_id_on_toggle → None [B7]
    R->>R: import_native_history → None (mod.rs:563) → transcript empty [B2]
    U->>R: POST /chat RICH-CHAT-MSG-2
    R->>OC: session/new (no prior id) [B3]
    OC->>DB: session S2 (beta)
    R->>R: agent_chat_id = S2
    U->>R: PATCH channel=tmux
    R->>OC: opencode --session S2 → only beta visible [B4]
    U->>OC: TERMINAL-PHASE-MSG-3
    OC->>DB: S2 (gamma)
    U->>R: PATCH channel=json
    R->>DB: import S2 since watermark → beta+gamma; S1/alpha never referenced again
```
