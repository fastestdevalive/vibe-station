omp history fixtures for the at-rest importer (`omp_import.rs`).

## Session files

Each `<filename>` below is a full omp session `.jsonl` in omp's documented
`session.md` format (version 3).

- `session-18.12.6-tool-turn.jsonl` — REAL capture from omp 18.12.6
  (deepseek-local/deepseek-v4-flash-0731). One tool-using turn: `read` then
  `write`, each with a `tool_execution_start`, a `toolResult`, and a final
  plain-text assistant message; ends with a `session_exit` leaf. The `title`
  slot is padded; assistant messages carry `"\n\n"` lead text blocks and
  injected `"i"` intent args in `toolCall.arguments`.
- `session-18.12.6-two-plain-turns.jsonl` — REAL capture from omp 18.12.6
  (deepseek-local/deepseek-v4-flash-0731). Two plain (no-tool) turns: "Hi" then
  "one, two, three, four, five"; ends with a `session_exit` leaf.
- `session-synthetic-edge.jsonl` — SYNTHETIC, hand-built from the shape of the
  real tool-turn file to exercise the importer's edge paths. It adds: a user
  message whose `content` is a plain STRING; an `attribution:"agent"` user entry
  (injected — must be skipped); an assistant `thinking` block; a `reset_boundary`
  (drops the pre-boundary turn); a `compaction`; an abandoned sibling `message`
  whose `parentId` forks off the active path; a trailing `model_usage` entry on
  an off-branch `parentId` (excluded from the leaf). Not a real omp capture.

## Non-session file

- `models-18.12.6.json` — REAL `omp models --json` output from omp 18.12.6
  (only deepseek-local was configured); the anthropic and image rows are
  synthetic, copied from the real row's shape, to exercise multi-provider and
  non-chat filtering (used by `omp.rs::parse_omp_models` tests, unrelated to
  the session importer).
