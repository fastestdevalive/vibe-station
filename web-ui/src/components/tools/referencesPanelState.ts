import {
  failureHeadline,
  isDependencyFailure,
  type LspFailure,
  type LspFallbackReason,
  type LspStatus,
} from "@/lib/lspApi";

/**
 * The References panel's whole UI state, computed ONCE per render by
 * `derivePanelState` (pure — unit-tested in isolation). The header and the
 * body each `switch` on it; neither re-derives anything from raw flags. This
 * is what keeps regressions like "Cancel reported as zero results" (S2) or
 * "pagination labelled as indexing" (S13) from silently coming back.
 *
 * State ids (S0…S16) refer to the catalog in
 * `.vibekit/reports/2026-10-02-round2-investigation.md` § Bug 5; S17 is
 * `.vibekit/reports/2026-10-02-lsp-missing-dependency-ux.md` § 1b. S6
 * (stopped) is intentionally absent: the daemon auto-resumes a stopped
 * server on the next request, so a query can never end in that state.
 */
export type PanelState =
  /** S0 — panel opened, no query yet. */
  | { kind: "empty" }
  /** S1 — first page in flight. */
  | { kind: "searching" }
  /** S2 — user cancelled the first page. */
  | { kind: "cancelled" }
  /** S3/S4 — 409 LSP_NOT_READY; `retrying` while the auto-retry loop runs. */
  | { kind: "starting"; attempt: number; retrying: boolean }
  /** S5 */
  | { kind: "disabled" }
  /** S7 — no server binary on this host. */
  | { kind: "not_found" }
  /** S8 */
  | { kind: "unsupported" }
  /** S9 */
  | { kind: "error"; message: string }
  /** S17 — the server failed to start (latched) and no text fallback ran
   *  (e.g. external file, or the request itself 503'd). */
  | { kind: "server_failed"; failure: LspFailure }
  /** S10 — the query completed with zero hits. `failure` set when the text
   *  fallback ran because the server failed. */
  | { kind: "no_results"; fallback: LspFallbackReason | null; failure: LspFailure | null }
  /** S16 — go-to-definition resolved nothing (no references fetched). */
  | { kind: "no_definition"; degraded: string | null }
  /** S11 / S12 (textOnly) / S13 (loadingMore) / S15 (degraded). */
  | {
      kind: "results";
      count: number;
      hasMore: boolean;
      loadingMore: boolean;
      textOnly: boolean;
      fallback: LspFallbackReason | null;
      degraded: string | null;
      /** Set when these are text matches because the server failed. */
      failure: LspFailure | null;
    };

/** What a query/fetch ended in, as recorded by the component. */
export type FetchOutcome =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "cancelled" }
  | { kind: "starting"; attempt: number; retrying: boolean }
  | { kind: "disabled" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }
  /** The request 503'd `LSP_SERVER_FAILED` (no text fallback possible). */
  | { kind: "server_failed"; failure: LspFailure }
  | { kind: "done" };

export interface PanelInputs {
  query: { symbol: string; intent: "references" | "no-definition" } | null;
  outcome: FetchOutcome;
  /** A "Show more" page is in flight (first page already rendered). */
  loadingMore: boolean;
  totalCount: number;
  hasMore: boolean;
  /** Every row is a `confidence: "text"` hit. */
  allText: boolean;
  /** Response-level reason the daemon substituted text search, if it did. */
  fallback: LspFallbackReason | null;
  /** Polled server status (only `not_found`/`degraded` are consulted). */
  lspStatus: LspStatus | null;
  degraded: string | null;
  /** Polled latched server failure, if any. */
  failure: LspFailure | null;
}

export function derivePanelState(i: PanelInputs): PanelState {
  if (!i.query) return { kind: "empty" };
  const o = i.outcome;
  // The failure that explains this result: the 503 body's own, else the
  // polled one — but the polled one only explains a `server_failed` text
  // fallback or a query that never reached the server (no-definition), not
  // a fresh LSP answer that raced a stale poll.
  const failure =
    o.kind === "server_failed"
      ? o.failure
      : i.fallback === "server_failed" || i.query.intent === "no-definition"
        ? i.failure
        : null;

  // Results already on screen outrank everything except a fresh first-page
  // load: pagination, a failed "Show more", or a later status change never
  // replace the list (S13).
  if (i.totalCount > 0 && o.kind !== "loading" && o.kind !== "starting") {
    return {
      kind: "results",
      count: i.totalCount,
      hasMore: i.hasMore,
      loadingMore: i.loadingMore,
      textOnly: i.allText || i.fallback != null,
      fallback: i.fallback,
      degraded: i.degraded,
      failure,
    };
  }

  switch (o.kind) {
    case "loading":
      return { kind: "searching" };
    case "cancelled":
      return { kind: "cancelled" };
    case "starting":
      return { kind: "starting", attempt: o.attempt, retrying: o.retrying };
    case "disabled":
      return { kind: "disabled" };
    case "unsupported":
      return { kind: "unsupported" };
    case "server_failed":
      return { kind: "server_failed", failure: o.failure };
    case "error":
      return { kind: "error", message: o.message };
    case "idle":
      // A no-definition query never fetches on its own. When the server
      // never ran, "{server} found no definition" would be false — S17.
      if (i.query.intent !== "no-definition") return { kind: "searching" };
      return failure ? { kind: "server_failed", failure } : { kind: "no_definition", degraded: i.degraded };
    case "done":
      if (i.query.intent === "no-definition") {
        return failure ? { kind: "server_failed", failure } : { kind: "no_definition", degraded: i.degraded };
      }
      if (i.fallback === "not_found" || i.lspStatus === "not_found") return { kind: "not_found" };
      if (i.fallback === "unsupported") return { kind: "unsupported" };
      return { kind: "no_results", fallback: i.fallback, failure };
  }
}

export type ChipTone = "ok" | "warn" | "error" | "muted";

export interface PanelChip {
  tone: ChipTone;
  /** One word, never a sentence. */
  word: string;
  /** Detail lives here, not in the bar. */
  tooltip: string;
  spinner: boolean;
}

export interface ChipContext {
  /** Server display name, e.g. "rust-analyzer" / "Rust". */
  serverName: string;
  lspStatus: LspStatus | null;
}

const FALLBACK_REASON_TEXT: Record<LspFallbackReason, string> = {
  disabled: "Code navigation is off",
  starting: "Language server starting",
  not_found: "No language server on this host",
  unsupported: "No language server for this file type",
  // Generic: callers prefer the failure's own headline when they have it.
  server_failed: "Language server failed to start",
};

/** Short human reason for a text-search fallback (picker header, hint rows).
 *  A known server failure names the missing thing instead of the generic
 *  `server_failed` text. */
export function fallbackReasonText(
  reason: LspFallbackReason | null,
  lspStatus?: LspStatus | null,
  failure?: LspFailure | null,
): string {
  if (failure && (reason === "server_failed" || reason == null)) return failureHeadline(failure);
  if (reason) return FALLBACK_REASON_TEXT[reason] ?? FALLBACK_REASON_TEXT.server_failed;
  if (lspStatus === "disabled") return FALLBACK_REASON_TEXT.disabled;
  if (lspStatus === "not_found") return FALLBACK_REASON_TEXT.not_found;
  return "Language server unavailable";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The single status chip for a state — the one table every word comes from. */
export function chipFor(state: PanelState, ctx: ChipContext): PanelChip | null {
  const name = ctx.serverName;
  const indexing = ctx.lspStatus === "indexing";
  switch (state.kind) {
    case "empty":
      return null;
    case "searching":
      return indexing
        ? { tone: "warn", word: "Indexing", tooltip: `${name} is indexing — results may take a moment`, spinner: true }
        : { tone: "muted", word: "Searching", tooltip: `Asking ${name}…`, spinner: true };
    case "cancelled":
      return { tone: "muted", word: "Cancelled", tooltip: "Search cancelled", spinner: false };
    case "starting":
      return {
        tone: "warn",
        word: indexing ? "Indexing" : "Starting",
        tooltip: state.retrying
          ? `${name} is ${indexing ? "indexing" : "starting"} — retrying automatically (attempt ${state.attempt})`
          : `${name} is still starting — refresh to try again`,
        spinner: state.retrying,
      };
    case "disabled":
      return { tone: "muted", word: "Off", tooltip: "Code navigation is disabled for this workspace", spinner: false };
    case "not_found":
      return { tone: "muted", word: "No server", tooltip: `${name} not found on this host`, spinner: false };
    case "unsupported":
      return { tone: "muted", word: "N/A", tooltip: "No language server for this file type", spinner: false };
    case "error":
      return { tone: "error", word: "Error", tooltip: truncate(state.message, 200), spinner: false };
    case "server_failed":
      return isDependencyFailure(state.failure)
        ? { tone: "warn", word: "Setup", tooltip: truncate(state.failure.summary, 200), spinner: false }
        : { tone: "error", word: "Error", tooltip: truncate(state.failure.summary, 200), spinner: false };
    case "no_results":
      if (state.failure) {
        return {
          tone: "warn",
          word: "Text",
          tooltip: `${failureHeadline(state.failure)} — showing text matches (may include unrelated hits)`,
          spinner: false,
        };
      }
      return state.fallback
        ? { tone: "warn", word: "Text", tooltip: `${fallbackReasonText(state.fallback)} — text search`, spinner: false }
        : { tone: "ok", word: "LSP", tooltip: `${name}: ready`, spinner: false };
    case "no_definition":
      return state.degraded
        ? { tone: "warn", word: "Partial", tooltip: `${name}: ${truncate(state.degraded, 200)}`, spinner: false }
        : { tone: "ok", word: "LSP", tooltip: `${name}: ready`, spinner: false };
    case "results":
      if (state.textOnly) {
        return {
          tone: "warn",
          word: "Text",
          tooltip: `${fallbackReasonText(state.fallback, ctx.lspStatus, state.failure)} — showing text matches (may include unrelated hits)`,
          spinner: false,
        };
      }
      if (state.degraded) {
        return { tone: "warn", word: "Partial", tooltip: `${name}: ${truncate(state.degraded, 200)}`, spinner: false };
      }
      return { tone: "ok", word: "LSP", tooltip: `${name}: ready`, spinner: false };
  }
}

/** The header's single right-hand button: cancel while in flight, else refresh. */
export function headerActionFor(state: PanelState): "cancel" | "refresh" | null {
  switch (state.kind) {
    case "empty":
    case "disabled":
    case "not_found":
    case "unsupported":
      return null;
    case "searching":
      return "cancel";
    case "starting":
      return state.retrying ? "cancel" : "refresh";
    case "results":
      return state.loadingMore ? "cancel" : "refresh";
    default:
      return "refresh";
  }
}
