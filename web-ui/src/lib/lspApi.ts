import { fileBase, apiFetch, parseJson } from "../api/client";
import { ApiError } from "../api/errors";
import type { FileScope } from "../api/types";

export type LspStatus =
  | "unsupported"
  | "not_found"
  | "starting"
  | "indexing"
  | "ready"
  | "idle"
  | "stopped"
  | "error"
  | "disabled";

export type LspFileRef =
  | { kind: "workspace"; path: string }
  | { kind: "external"; token: string };

export type LspSeverity = "ok" | "warn" | "error" | "neutral";

/** Machine-readable click action — dispatch on this, never on `actionLabel`.
 *  `null` (not clickable) is expressed at each use site as `LspAction | null`,
 *  mirroring Rust's `Option<LspAction>` rather than folding `null` into the
 *  action type itself. */
export type LspAction = "enable" | "resume" | "retry";

/** Why a language server is not up (`vst_types::rest::lsp::LspFailureKind`).
 *  `missing_dependency`/`incompatible_dependency` are user-fixable setup
 *  facts ("Setup needed"); the rest are malfunctions ("Error"). */
export type LspFailureKind =
  | "missing_dependency"
  | "incompatible_dependency"
  | "init_failed"
  | "exited_on_start"
  | "init_timeout"
  | "crashed"
  | "spawn_failed";

/** One remediation button. Dispatch on `kind` — `label` is display text only. */
export type LspRemediation = {
  kind: "copy_command" | "retry" | "view_log";
  label: string;
  /** Only for `copy_command`: the daemon-authored install command. */
  command?: string | null;
};

/** A latched server failure — set on status responses only while the server
 *  is not up (`status === "error"`); never together with `degraded`. */
export type LspFailure = {
  kind: LspFailureKind;
  /** Short daemon-authored sentence (== `detail` while failed). */
  summary: string;
  /** Raw server text (init error / stderr tail), ≤2 KB, may be multi-line. */
  message: string | null;
  exitCode?: number | null;
  remediation: LspRemediation[];
  /** The daemon will retry on its own (crash backoff / dependency re-probe). */
  autoRetry: boolean;
};

/** Dependency kinds read as "Setup needed" (warn), not "Error". */
export function isDependencyFailure(failure: LspFailure | null | undefined): boolean {
  return failure?.kind === "missing_dependency" || failure?.kind === "incompatible_dependency";
}

/**
 * The failure summary's lead clause, for places that need a short phrase
 * rather than the full sentence (picker header, chip tooltip, banners):
 * "TypeScript isn't installed for this project — code navigation needs it."
 * → "TypeScript isn't installed for this project". Pure text trimming of the
 * daemon's own words — never a re-derivation from `kind`.
 */
export function failureHeadline(failure: LspFailure): string {
  const firstSentence = failure.summary.split(/(?<=\.)\s/)[0] ?? failure.summary;
  const lead = firstSentence.split(/ — |: /)[0] ?? firstSentence;
  return lead.trim().replace(/[.…]+$/, "");
}

/**
 * Presentation fields computed once, server-side, in `vst_lsp::status::describe`
 * — flattened into both `LspStatusResponse` and `LspLanguageStatus`. Frontend
 * only renders these; it does not re-derive label/color/action from `status`.
 */
export type LspStatusPresentation = {
  label: string;
  displayName: string | null;
  severity: LspSeverity;
  detail: string;
  action: LspAction | null;
  actionLabel: string | null;
};

export type LspStatusResponse = {
  status: LspStatus;
  language: string | null;
  /** Server is up but reported a health warning/error (rust-analyzer
   *  `experimental/serverStatus`, e.g. "cargo metadata failed") — results may
   *  be incomplete. Absent/null when healthy or the server never reports it. */
  degraded?: LspDegraded | null;
  /** Why the server is not up (only with `status === "error"`). */
  failure?: LspFailure | null;
} & LspStatusPresentation;

/** `level: "info"` is a note (e.g. "Using TypeScript 5.9.3 (global)…"), not a
 *  warning — it must not turn any chip yellow. Absent ≡ `"warning"`. */
export type LspDegraded = { message: string; level?: "warning" | "info" };

/** Why the daemon substituted a ripgrep text search for the language server.
 *  Present on definition/references responses ONLY when it did. */
export type LspFallbackReason = "disabled" | "starting" | "not_found" | "unsupported" | "server_failed";
export type LspFallback = { reason: LspFallbackReason };

export type Location = {
  line: number;
  /** UTF-16 column of the match start within `preview`. */
  character: number;
  /** UTF-16 exclusive end column — set only for single-line ranges. */
  endCharacter?: number | null;
  /** The RAW source line (untrimmed; only the line terminator is stripped) —
   *  `character`/`endCharacter` index into it. Trim for display only. */
  preview: string;
  confidence: "lsp" | "text";
} & (
  | { external: false; path: string; token?: null; displayPath?: null }
  | { external: true; path: null; token: string | null; displayPath: string | null }
);

export type LspDefinitionResponse = {
  locations: Location[];
  fallback?: LspFallback | null;
};

export async function getLspStatus(
  api: unknown,
  scope: FileScope,
  id: string,
  path: string
): Promise<LspStatusResponse> {
  const url = `${fileBase(scope, id)}/lsp/status?path=${encodeURIComponent(path)}`;
  if (api && typeof (api as { apiFetch?: typeof apiFetch }).apiFetch === "function") {
    const res = await (api as { apiFetch: typeof apiFetch }).apiFetch(url);
    return parseJson<LspStatusResponse>(res);
  }
  const res = await apiFetch(url);
  return parseJson<LspStatusResponse>(res);
}

export type LspLanguageStatus = {
  language: string;
  status: LspStatus;
  failure?: LspFailure | null;
} & LspStatusPresentation;

export type LspStatusesResponse = {
  statuses: LspLanguageStatus[];
};

/**
 * Read-only "all languages" breakdown for a workspace — every language the
 * daemon has spawned an LSP server for so far this session, each with its
 * own status. Used only by the status row's popup, on-demand when it opens
 * (not polled).
 */
export async function getLspStatuses(
  api: unknown,
  scope: FileScope,
  id: string
): Promise<LspLanguageStatus[]> {
  const url = `${fileBase(scope, id)}/lsp/statuses`;
  if (api && typeof (api as { apiFetch?: typeof apiFetch }).apiFetch === "function") {
    const res = await (api as { apiFetch: typeof apiFetch }).apiFetch(url);
    return (await parseJson<LspStatusesResponse>(res)).statuses;
  }
  const res = await apiFetch(url);
  return (await parseJson<LspStatusesResponse>(res)).statuses;
}

/**
 * Retry a failed language server: clears the daemon's latched failure and
 * respawns now (`POST …/lsp/restart`). Returns the fresh status.
 */
export async function restartLsp(
  api: unknown,
  scope: FileScope,
  id: string,
  language: string
): Promise<LspStatusResponse> {
  const url = `${fileBase(scope, id)}/lsp/restart`;
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language }),
  };
  if (api && typeof (api as { apiFetch?: typeof apiFetch }).apiFetch === "function") {
    const res = await (api as { apiFetch: typeof apiFetch }).apiFetch(url, init);
    return parseJson<LspStatusResponse>(res);
  }
  const res = await apiFetch(url, init);
  return parseJson<LspStatusResponse>(res);
}

export async function getDefinition(
  api: unknown,
  scope: FileScope,
  id: string,
  file: LspFileRef,
  line: number,
  character: number
): Promise<LspDefinitionResponse> {
  const url = `${fileBase(scope, id)}/lsp/definition`;
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file, line, character }),
  };
  if (api && typeof (api as { apiFetch?: typeof apiFetch }).apiFetch === "function") {
    const res = await (api as { apiFetch: typeof apiFetch }).apiFetch(url, init);
    return parseJson<LspDefinitionResponse>(res);
  }
  const res = await apiFetch(url, init);
  return parseJson<LspDefinitionResponse>(res);
}

export type LspHoverResponse =
  | { signature: string; doc: string | null }
  | { empty: true };

export type ReferenceEntry = {
  line: number;
  /** UTF-16 column of the reference start within `preview`. */
  character: number;
  /** UTF-16 exclusive end column — set only for single-line ranges. */
  endCharacter?: number | null;
  /** The RAW source line (untrimmed) — `character`/`endCharacter` index into it. */
  preview: string;
  isDeclaration: boolean;
  confidence: "lsp" | "text";
};

export type ReferenceGroup = {
  path: string | null;
  external: boolean;
  token: string | null;
  displayPath: string | null;
  entries: ReferenceEntry[];
};

export type LspReferencesResponse = {
  references: ReferenceGroup[];
  hasMore: boolean;
  cursor: string | null;
  fallback?: LspFallback | null;
};

export async function getHover(
  api: unknown,
  scope: FileScope,
  id: string,
  file: LspFileRef,
  line: number,
  character: number
): Promise<LspHoverResponse> {
  const url = `${fileBase(scope, id)}/lsp/hover`;
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file, line, character }),
  };
  if (api && typeof (api as { apiFetch?: typeof apiFetch }).apiFetch === "function") {
    const res = await (api as { apiFetch: typeof apiFetch }).apiFetch(url, init);
    return parseJson<LspHoverResponse>(res);
  }
  const res = await apiFetch(url, init);
  return parseJson<LspHoverResponse>(res);
}

export async function getReferences(
  api: unknown,
  scope: FileScope,
  id: string,
  file: LspFileRef,
  line: number,
  character: number,
  cursor?: string | null
): Promise<LspReferencesResponse> {
  const url = `${fileBase(scope, id)}/lsp/references`;
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file, line, character, cursor }),
  };
  if (api && typeof (api as { apiFetch?: typeof apiFetch }).apiFetch === "function") {
    const res = await (api as { apiFetch: typeof apiFetch }).apiFetch(url, init);
    return parseJson<LspReferencesResponse>(res);
  }
  const res = await apiFetch(url, init);
  return parseJson<LspReferencesResponse>(res);
}

export type OutlineSymbol = {
  name: string;
  kind: string;
  /** Position of the symbol's NAME (LSP `selectionRange.start`) — where a
   *  click should land. */
  line: number;
  character: number;
  /** First line of the symbol's FULL range (doc comments, attributes,
   *  decorators included) — used with `endLine` for scroll-sync containment.
   *  Optional for daemons predating it; fall back to `line`. */
  rangeStartLine?: number;
  endLine: number;
  children: OutlineSymbol[];
};

export type LspOutlineResponse =
  | { symbols: OutlineSymbol[] }
  | { unsupported: true };

export async function getOutline(
  api: unknown,
  scope: FileScope,
  id: string,
  file: LspFileRef | string
): Promise<LspOutlineResponse> {
  const fileParam =
    typeof file === "string"
      ? file
      : file.kind === "external"
        ? `external:${file.token}`
        : `workspace:${file.path}`;
  const url = `${fileBase(scope, id)}/lsp/outline?file=${encodeURIComponent(fileParam)}`;

  if (api && typeof (api as { apiFetch?: typeof apiFetch }).apiFetch === "function") {
    const res = await (api as { apiFetch: typeof apiFetch }).apiFetch(url);
    return parseJson<LspOutlineResponse>(res);
  }
  const res = await apiFetch(url);
  return parseJson<LspOutlineResponse>(res);
}

export async function getExternalFile(
  api: unknown,
  scope: FileScope,
  id: string,
  token: string
): Promise<string> {
  if (
    api &&
    typeof (api as { getExternalFile?: (id: string, token: string, scope?: FileScope) => Promise<string> })
      .getExternalFile === "function"
  ) {
    return (
      api as { getExternalFile: (id: string, token: string, scope?: FileScope) => Promise<string> }
    ).getExternalFile(id, token, scope);
  }
  const url = `${fileBase(scope, id)}/lsp/external-file/${encodeURIComponent(token)}`;
  let res: Response;
  if (api && typeof (api as { apiFetch?: typeof apiFetch }).apiFetch === "function") {
    res = await (api as { apiFetch: typeof apiFetch }).apiFetch(url);
  } else {
    res = await apiFetch(url);
  }
  if (res.status === 422) throw new ApiError("File too large to preview", 422);
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try {
      const j = JSON.parse(text) as { error?: string; message?: string };
      msg = j.error ?? j.message ?? text;
    } catch {
      /* not JSON */
    }
    throw new ApiError(msg, res.status);
  }
  return res.text();
}

/**
 * Raw workspace file content, for callers (like the outline panel) that
 * only receive `api: unknown` and can't rely on the full `ApiInstance`
 * type's `getFile`. Duck-types the same way `getOutline`/`getExternalFile`
 * above do: use `api.getFile` when it's a real ApiInstance, else hit the
 * REST route directly.
 */
export async function getWorkspaceFile(
  api: unknown,
  scope: FileScope,
  id: string,
  path: string
): Promise<string> {
  if (
    api &&
    typeof (api as { getFile?: (id: string, path: string, scope?: FileScope) => Promise<string> })
      .getFile === "function"
  ) {
    return (api as { getFile: (id: string, path: string, scope?: FileScope) => Promise<string> }).getFile(
      id,
      path,
      scope
    );
  }
  const cleanPath = path.replace(/^\/+/, "");
  const url = `${fileBase(scope, id)}/files/${cleanPath}`;
  const res =
    api && typeof (api as { apiFetch?: typeof apiFetch }).apiFetch === "function"
      ? await (api as { apiFetch: typeof apiFetch }).apiFetch(url)
      : await apiFetch(url);
  if (res.status === 422) throw new ApiError("File too large to preview", 422);
  if (!res.ok) throw new ApiError(res.statusText, res.status);
  return res.text();
}

function extractErrorCode(err: unknown): string | null {
  if (err && typeof err === "object") {
    if ("code" in err && typeof (err as { code: unknown }).code === "string") {
      return (err as { code: string }).code;
    }
  }
  if (err instanceof Error) {
    try {
      const parsed = JSON.parse(err.message);
      if (parsed && typeof parsed.code === "string") {
        return parsed.code;
      }
    } catch {
      // not JSON
    }
  }
  return null;
}

function isLspFailure(v: unknown): v is LspFailure {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as { kind?: unknown }).kind === "string" &&
    typeof (v as { summary?: unknown }).summary === "string"
  );
}

/**
 * The latched failure carried by a `503 LSP_SERVER_FAILED` route error
 * (`{ error, code: "LSP_SERVER_FAILED", failure }`), or `null` for any other
 * error. Accepts an `ApiError` whose message is the raw JSON body (what
 * `parseJson` throws) or an already-parsed body object.
 */
export function lspFailureFromError(err: unknown): LspFailure | null {
  let body: unknown = null;
  if (err && typeof err === "object" && "failure" in err) {
    body = err;
  } else if (err instanceof Error) {
    try {
      body = JSON.parse(err.message);
    } catch {
      return null;
    }
  }
  if (!body || typeof body !== "object") return null;
  const { code, failure } = body as { code?: unknown; failure?: unknown };
  if (code !== undefined && code !== "LSP_SERVER_FAILED") return null;
  return isLspFailure(failure) ? { ...failure, remediation: failure.remediation ?? [] } : null;
}

export function isLspDisabled(err: unknown): boolean {
  const code = extractErrorCode(err);
  if (code === "LSP_DISABLED") return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (msg.includes("LSP_DISABLED") || msg.toLowerCase().includes("code navigation is disabled")) {
    return true;
  }
  return false;
}

export function isLspUnsupported(err: unknown): boolean {
  const code = extractErrorCode(err);
  if (code === "LSP_UNSUPPORTED") return true;
  if (err instanceof ApiError && err.status === 422) return true;
  if (err && typeof err === "object" && "status" in err && (err as { status: unknown }).status === 422) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return msg.includes("LSP_UNSUPPORTED");
}

/**
 * True when `err` is the daemon's `409 LSP_NOT_READY` — the language server
 * process was just spawned (spawn-on-first-use) and hasn't finished its
 * initialize handshake yet. This is transient and expected on a freshly
 * opened file; callers should retry rather than treat it as "no result"
 * (an LSP route's `NotReady` maps to this exact status/code — see
 * `LspRouteError::NotReady` in `rust/vst-routes/src/lsp.rs`).
 *
 * Excludes `LSP_DISABLED` (which is also 409 but non-retryable) and `LSP_UNSUPPORTED`.
 *
 * Shared by CodeView.tsx's go-to-definition retry and OutlinePanel.tsx's
 * outline-fetch retry — keep both in sync with this one check.
 */
export function isLspNotReady(err: unknown): boolean {
  if (isLspDisabled(err)) return false;
  if (isLspUnsupported(err)) return false;
  const code = extractErrorCode(err);
  if (code === "LSP_NOT_READY") return true;
  if (code && code !== "LSP_NOT_READY") return false;

  if (err instanceof ApiError) {
    return err.status === 409;
  }
  if (err && typeof err === "object" && "status" in err && (err as { status: unknown }).status === 409) {
    return true;
  }
  if (err instanceof Error) {
    return (
      err.message.includes("409") ||
      err.message.includes("LSP_NOT_READY")
    );
  }
  return false;
}
