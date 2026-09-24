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

export type LspStatusResponse = {
  status: LspStatus;
  language: string | null;
};

export type Location = {
  line: number;
  character: number;
  preview: string;
  confidence: "lsp" | "text";
} & (
  | { external: false; path: string; token?: null; displayPath?: null }
  | { external: true; path: null; token: string | null; displayPath: string | null }
);

export type LspDefinitionResponse = {
  locations: Location[];
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
};

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
  character: number;
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
  line: number;
  character: number;
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

/**
 * True when `err` is the daemon's `409 LSP_NOT_READY` — the language server
 * process was just spawned (spawn-on-first-use) and hasn't finished its
 * initialize handshake yet. This is transient and expected on a freshly
 * opened file; callers should retry rather than treat it as "no result"
 * (an LSP route's `NotReady` maps to this exact status/code — see
 * `LspRouteError::NotReady` in `rust/vst-routes/src/lsp.rs`).
 *
 * Shared by CodeView.tsx's go-to-definition retry and OutlinePanel.tsx's
 * outline-fetch retry — keep both in sync with this one check.
 */
export function isLspNotReady(err: unknown): boolean {
  return (
    (err instanceof ApiError && err.status === 409) ||
    (err instanceof Error &&
      (err.message.includes("409") ||
        err.message.includes("LSP_NOT_READY") ||
        (err as { code?: string }).code === "LSP_NOT_READY"))
  );
}
