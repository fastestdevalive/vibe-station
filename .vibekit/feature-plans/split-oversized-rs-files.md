# Split oversized Rust files (Tier 1)

Status: not started — deferred until in-flight work on these files lands.

## Goal

- Get every non-vendor `.rs` file under 2000 lines (guardrails ceiling is 1,500; CI enforces 2000 via `scripts/check-rs-loc.sh`)
- Pure moves only: no behaviour change, no public API change, `cargo test` output identical before/after
- Remove each file from `scripts/rs-loc-allowlist.txt` as it is split

## Out of scope

- New crates (the earlier "Tier 2": `vst-session-ops`, `vst-fileview`, `vst-http-handlers`) — explicitly dropped
- Deduplicating `projects.rs` / `worktrees.rs` file/diff/git handlers (needs a shared crate)
- Shortening long functions (e.g. `patch_session_channel` ~475 lines)

## Technique

- A type's `impl` can span modules in one crate: keep the struct in `mod.rs`, put method groups in sibling files each with their own `impl X { ... }`
- Keep `pub use` re-exports in `mod.rs` so external paths (`vst_routes::sessions::X`) don't change
- Fields/helpers used across sibling files become `pub(super)`/`pub(crate)`
- One file per PR step, `cargo test -p <crate>` green before the next

## Files (current line counts)

### `rust/vst-routes/src/sessions.rs` (7,611) → `sessions/`

| File | Contents | ~Lines |
|------|----------|-------:|
| `mod.rs` | `SessionRoutes` struct, ctor, Clone/Debug, re-exports | 300 |
| `context.rs` | `SessionContext`, `find_*_context`, `serialize_*`, pin repair | 450 |
| `errors.rs` | all `*Error` / `*Result` enums | 350 |
| `create.rs` | `create_session`, draft/normal/direct/worktree, spawn jobs | 1,200 |
| `spawn.rs` | `spawn_session`, `SpawnSessionOpts`, `await_ready_*` | 500 |
| `start.rs` | `start_session`, `start_new_worktree`, `start_direct` | 750 |
| `lifecycle.rs` | delete, done, delink, pin, rename, reorder | 700 |
| `resume.rs` | `resume_*`, `resolve_resume_mode`, `pick_resume_model` | 450 |
| `reset.rs` | `reset_session`, `ResetFlag`/`ResetCancels`, carry/withdraw | 1,100 |
| `handoff.rs` | `handoff_session`, `wait_for_*`, handoff path/instruction | 450 |
| `chat.rs` | send, chat, notices, queued turns, chat model | 550 |
| `channel.rs` | `patch_session_channel`, `spawn_tty_for_agent` | 600 |
| `transcript.rs` | transcript/tail/all, `group_json_output`, meta | 250 |
| `schedule.rs` | `schedule_*`, fire-at normalisation | 450 |
| `tests/` | the two inline test modules, split by topic | 350 |

### `rust/vst-daemon/src/server.rs` (5,031) → `server/`

| File | Contents |
|------|----------|
| `mod.rs` | `BuildServerOptions`, `build_server`, `router_from_state` (route table only) |
| `origin.rs` | origin policy, `is_local_origin`, `network_peer_gate` |
| `ws/{mod,dispatch,socket}.rs` | `WsCommand`/`DispatchLane`, `handle_socket` |
| `handlers/projects.rs` | project handlers |
| `handlers/worktrees.rs` | worktree handlers |
| `handlers/sessions.rs` | session handlers |
| `handlers/lsp.rs` | LSP handlers |
| `handlers/attachments.rs` | attachments |
| `handlers/settings.rs` | modes, oobe, limits, ordered lists, doctor |
| `handlers/fs.rs`, `auth.rs`, `tunnel.rs` | fs, auth, mobile auth / tailscale / continue |
| `spa.rs` | `with_spa_csp`, `handle_fallback` |

Each handler file 300–900 lines. Existing `notify_listener_tests` module stays wired from `mod.rs`.

### `rust/vst-routes/src/worktrees.rs` (2,740) → `worktrees/`

- `mod.rs`: struct, errors, ctor, serialisers
- `crud.rs`: list, create, pin, hide, rename, reorder, done, delete
- `files.rs`: tree, file_list, search, get_file, open-file durable
- `git.rs`: diff, changed_paths, diffstat, commits, submodules, pr
- `gutter.rs`: `compute_git_gutter`, `parse_diff_hunk` (leave in routes; moving to `vst-diff` is out of scope)
- `disk.rs`: disk usage

### `rust/vst-routes/src/projects.rs` (2,185) → `projects/`

- `mod.rs`: struct, errors, ctor
- `crud.rs`: list, create, patch, delete
- `create_new.rs`: `create_new_project` (~500 lines) + spawn jobs
- `files.rs`, `git.rs`: file and git handlers
- `paths.rs`: `expand_tilde`, `resolve_inside_dir`, `assert_safe_to_delete`

### `rust/vst-lsp/src/manager.rs` (2,208) → `manager/`

- `mod.rs`: `LspManager` + public API
- `server_task.rs`: `ServerTask`
- `readiness.rs`: `Readiness`, `ReadinessTracker`, health messages
- `crash.rs`: `CrashHistory`, `FailureRecord`, `Timing`
- `paths.rs`: `is_sensitive_path`, `resolve_workspace_path`, `ExternalTokenMap`
- `parse.rs`: location/definition/references parsing
- `tests.rs`

### Tests

- `rust/vst-routes/tests/sessions_group_b2.rs` (2,604) and the other `sessions_group_*` files → `tests/sessions/main.rs` + `mod create; mod reset; mod handoff; mod channel; ...`
- `rust/vst-routes/tests/worktrees.rs` (2,394) → `tests/worktrees/main.rs` + `mod crud; mod files; mod git;`
- Shared helpers (`store()`, `routes_with_real_json_gate`, `create_direct_agent`) → `tests/common/mod.rs`
- Replace opaque `group_a/b1/b2/c/d` names with topic names

## Order

- [ ] `sessions.rs` (largest; biggest conflict risk — do when no one else is editing it)
- [ ] `server.rs`
- [ ] `tests/sessions*` and `tests/worktrees.rs`
- [ ] `worktrees.rs`
- [ ] `projects.rs`
- [ ] `manager.rs`
- [ ] Delete `scripts/rs-loc-allowlist.txt` and the allowlist handling in `scripts/check-rs-loc.sh`; consider lowering `MAX_LOC` to 1500

## Verification (each step)

- `cargo fmt --check`, `cargo clippy --workspace`, `cargo test -p <crate>` identical pass/fail set to before
- `bash scripts/check-rs-loc.sh` — will flag the allowlist entry as STALE once the file is under 2000; remove it in the same commit
- No `vst-types` / `web-ui/src/api/types.ts` changes expected
