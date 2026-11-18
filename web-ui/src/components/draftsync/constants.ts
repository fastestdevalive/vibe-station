/** Debounce between the last keystroke and the server write (Decision 5). */
export const DRAFT_TEXT_DEBOUNCE_MS = 600;

/** Per-scope cap in UTF-8 bytes; the daemon answers 413 `draft_too_large` above it. */
export const MAX_DRAFT_TEXT_BYTES = 65_536;

/** Above this, a `pagehide` flush skips the keepalive PUT (browsers cap a
 *  keepalive body at 64 KiB) and relies on the buffered text instead. */
export const KEEPALIVE_MAX_BYTES = 60 * 1024;

/** First retry delay after a retryable PUT failure; doubles per attempt. */
export const RETRY_BASE_MS = 1000;

/** Cap for the per-scope retry backoff (one timer per scope, no attempt limit). */
export const RETRY_MAX_MS = 30_000;

/** Scope of the Tier-2 new-agent prompt (the prompt only; `draftConfig` stays local). */
export const GLOBAL_NEW_SCOPE = "global-new";

/** Terminal send message scope: `review-picker:worktree:<id>` / `review-picker:project:<id>`. */
export const pickerScope = (scopeKey: string) => `review-picker:${scopeKey}`;
