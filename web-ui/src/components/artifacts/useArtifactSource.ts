import { useMemo } from "react";
import type { ArtifactRow, ArtifactScopeKind } from "@/api/types";
import { rowMatchesPath, useArtifactsStore } from "./artifactsStore";

/**
 * Where a previewed path's bytes come from (`FilePreviewPane`'s artifact seam, plan 8.4):
 *  - `none`: the normal worktree pipeline (relative path, or an LSP external peek carrying a token).
 *  - `loading`: an absolute path whose artifacts list has not loaded yet (never "evicted" before `ready`).
 *  - `artifact`: an absolute path with a live row; bytes come from `getArtifactContent(row.id)`.
 *  - `error`: the list fetch failed (never "loading" forever, never "evicted"); the pane offers Retry.
 *  - `evicted`: an absolute path, store `ready`, no row: "No longer an artifact".
 */
export type ArtifactSource =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "artifact"; row: ArtifactRow; isArtifact: true }
  | { kind: "error"; message: string }
  | { kind: "evicted" };

const NONE: ArtifactSource = { kind: "none" };
const LOADING: ArtifactSource = { kind: "loading" };
const EVICTED: ArtifactSource = { kind: "evicted" };

/** An absolute path is never a worktree-relative one; only an artifact row (or an LSP token) may name it. */
export function isAbsolutePath(path: string | null | undefined): path is string {
  return path != null && path.startsWith("/");
}

/**
 * Resolve the source of `path`. `external` is the LSP token flag: an absolute canonical path carrying a token is
 * NOT proof of an artifact and must keep rendering through its token.
 */
export function useArtifactSource(
  scopeKind: ArtifactScopeKind,
  scopeId: string | null,
  path: string | null,
  external: boolean,
): ArtifactSource {
  void scopeKind; // the store is keyed by scope id (worktree and project ids never collide)
  const absolute = !external && scopeId != null && isAbsolutePath(path);
  // `absolute` guarantees `path` is a canonical absolute path, which only ever equals a row's `path` (a display
  // path is repo-relative); the shared predicate keeps one rule for "which row is this tab".
  // Two narrow selectors (row identity + status) so unrelated store churn (notices, other rows) never
  // hands the pane a new source object and re-runs its fetch effects.
  const row = useArtifactsStore((s) => (absolute ? s.byScope[scopeId]?.rows.find((r) => rowMatchesPath(r, path)) : undefined));
  const status = useArtifactsStore((s) => (absolute ? s.byScope[scopeId]?.status : undefined));
  const error = useArtifactsStore((s) => (absolute ? s.byScope[scopeId]?.error : undefined));
  return useMemo<ArtifactSource>(() => {
    if (!absolute) return NONE;
    if (row) return { kind: "artifact", row, isArtifact: true };
    if (status === "error") return { kind: "error", message: error ?? "Couldn't load artifacts" };
    return status === "ready" ? EVICTED : LOADING;
  }, [absolute, row, status, error]);
}

/** The row behind a tab path (absolute path, or an in-repo repo-relative path) for the preview strip's pin. */
export function useArtifactRow(scopeId: string | null, path: string | null, enabled = true): ArtifactRow | undefined {
  return useArtifactsStore((s) => {
    if (!enabled || !scopeId || !path) return undefined;
    return s.byScope[scopeId]?.rows.find((r) => rowMatchesPath(r, path));
  });
}
