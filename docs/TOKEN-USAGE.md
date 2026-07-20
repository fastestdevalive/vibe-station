# Token / Usage Accounting

How `UsageInfo` (`daemon/src/types.ts`) — the status bar's token count, cost,
and (nominally) context-window percentage — is populated per CLI. Read this
before touching any plugin's `usage` extraction, `hasRealUsage`
(`daemon/src/services/jsonAgent.ts:61`), or `StatusBar.tsx`'s rendering of it.

**Bottom line: nothing here is estimated or tokenized locally.** Every
number is read directly off the CLI's own JSON output for that turn — the
daemon's only job is reshaping 4 different wire shapes into one common
`UsageInfo` struct, and (for `totalTokens`) summing fields that are already
correct individually.

## Per-CLI field mapping

| `UsageInfo` field | claude | cursor | opencode | agy |
|---|---|---|---|---|
| Source location | `claude.ts:132-154`, on the terminal `result` line | `cursor.ts:164-183`, on the terminal `result` line | `opencode.ts:103-124`, on **any** streamed part carrying `tokens` (can fire mid-turn, not just at the end) | `agy.ts:130-146`, on the single result envelope (agy has no streamed NDJSON) |
| `inputTokens` | `usage.input_tokens` | `usage.inputTokens` (camelCase; `input_tokens` as a defensive fallback) | `tokens.input` | `usage.input_tokens` |
| `outputTokens` | `usage.output_tokens` | `usage.outputTokens` | `tokens.output` | `usage.output_tokens` |
| `cacheReadTokens` | `usage.cache_read_input_tokens` | `usage.cacheReadTokens` | `tokens.cache.read` | always `0` — agy doesn't report cache usage |
| `cacheCreateTokens` | `usage.cache_creation_input_tokens` | `usage.cacheWriteTokens` (renamed on our side — cursor's own field is called "write", ours "create") | `tokens.cache.write` | always `0` — agy doesn't report cache usage |
| `totalTokens` | **daemon-computed**: `input + output + cacheRead + cacheCreate` | same, daemon-computed sum | same, daemon-computed sum | prefers the CLI's own `usage.total_tokens` when present, else falls back to `input + output` |
| `costUsd` | `total_cost_usd` (present) | `total_cost_usd` (present) | `part.cost` (present) | **never populated** — agy's envelope has no cost field at all |
| `contextWindow` | not populated by any plugin today | — | — | — |
| `model` | the `result` line's own `model`, else the turn's requested model (`fallbackModel`) — **never** a `modelUsage` map key, since that also enumerates subagent models (e.g. a haiku subagent) and would drift the status bar to the wrong model | `msg.model` | `msg.model` | the turn's requested model (agy's envelope carries no model field) |

## Things worth knowing when working on this

- **`totalTokens` is (almost) always re-derived, not read off the wire.** For
  claude/cursor/opencode it's always the daemon's own sum of the 4
  sub-fields — this is what keeps `UsageInfo` comparable across CLIs whose
  raw JSON shapes disagree on whether/how they report a combined total.
  agy is the one exception: it prefers the CLI's own `total_tokens` because
  agy folds `thinking_tokens` into that total server-side, with no separate
  slot in `UsageInfo` to preserve it — recomputing `input + output` alone
  would silently drop the thinking-token count agy already includes.
- **`contextWindow` is a dead field today.** It's defined on `UsageInfo`
  (`types.ts:62`) and `StatusBar.tsx` already knows how to render a
  `used / contextWindow (pct%)` display if it's ever populated — but no
  plugin extracts a context-window-size value from any CLI's output right
  now, so the percentage never actually renders; only the raw token count
  does. Wiring this up (if a CLI's output ever exposes it) is a live
  follow-up opportunity, not a bug — nothing is broken, the feature is just
  unused.
- **opencode is structurally different from the other three.** claude,
  cursor, and agy only ever emit usage once, at the very end of a turn (the
  terminal `result` line/envelope). opencode's `emitUsageAndResult` can fire
  on *any* streamed part that carries token data — mid-turn, potentially
  more than once — guarded by a `hasUsage` check so a zero-token
  intermediate streaming chunk doesn't get emitted as a spurious zero-usage
  event.
- **A turn with zero real usage must not clobber the running total.** Some
  turns hit the model without ever billing tokens — a claude slash command
  like `/model` or `/cost` completes without a real API call and reports
  `totalTokens: 0`. `hasRealUsage()` (`jsonAgent.ts:61`, gates every
  `usage`-event write, `jsonAgent.ts:883` and `:1097`) exists specifically
  so a no-op turn like that can't reset the status bar's cumulative counter
  back to zero — only a `usage` event with `totalTokens > 0` is allowed to
  overwrite the session's running `usage`.
- **cursor needed a field *rename*, not just a case change** — the mapping
  from cursor's `cacheWriteTokens` to our `cacheCreateTokens` is a
  semantic-equivalence decision (both mean "tokens spent writing new
  entries into the prompt cache"), not a typo to "fix" back to matching
  names later.
