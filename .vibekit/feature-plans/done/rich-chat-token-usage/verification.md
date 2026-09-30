# Verification: Rich Chat token usage

Captured by the orchestrating agent (the deepseek screenshot agent was blocked by provider quota).

## Setup

- Sandbox built from this worktree: `scripts/dev-sandbox.sh up --port=7102` → http://localhost:7102
- Needed a one-line fix first: `scripts/dev-entrypoint.sh` was missing a `fi` (removed by `f5fa899f`), so the container exited on a syntax error. Restored from `main` in the working tree (uncommitted).
- Session: real Claude Code (`mode-claude-001`, `--channel=json`) in `northstar-api/napi-1`, prompt `Reply with exactly: token check ok`.

## Result — CUJ 1 (usage shown after a turn): PASS

![Status bar after the turn](screenshots/status-bar-after-turn.png)

- Status bar: `24k / 1M tok (2%)` (compact format, cost hidden; raw total 23,970 / 1,000,000)
- `GET /api/sessions/<id>/meta` → `usage`: `totalTokens 23970`, `contextWindow 1000000`, `costUsd 0.0547` (still sent, not displayed), input 2 / output 6 / cacheRead 12157 / cacheCreate 11805
- Transcript event order: `usage`, `text`, `usage`, `usage`, `result`

- Model name: not shown (`meta.model` is null on the ACP path; only the mode name "Claude Code" appears) — known gap, not part of this change.

## Not verified

- **CUJ 2** (adapter with no usage → token block hidden): not run in the sandbox. Covered only by unit tests.
- **Restart persistence** (context % and cost survive a daemon restart): not run here; covered by the `JsonAgentSession` transcript-rebuild test.
- Mid-turn value vs. end-of-turn value on a multi-tool turn (the "% must not go up" fix): this prompt was a single call, so it doesn't exercise it.
