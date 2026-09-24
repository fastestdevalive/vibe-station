import { useMemo } from "react";
import type { DiffScope, FileScope } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";

export interface FilePreviewControlled {
  path: string | null;
  scope: DiffScope;
  commitSha?: string;
}

export interface PreviewedPathInfo {
  path: string | null;
  scope: DiffScope;
  fileScope: FileScope;
  isWorkingTreeView: boolean;
  external: { token: string; displayPath: string } | null;
}

/**
 * Extracts preview path, scope, external token, and working tree view status.
 * Shared between FilePreviewPane and OutlinePanel (Decision 8).
 */
export function usePreviewedPath(
  worktreeId: string | null,
  fileScope: FileScope = "worktree",
  controlled?: FilePreviewControlled,
): PreviewedPathInfo {
  const storePath = useWorkspaceStore((s) => s.activeFilePath);
  const peekFile = useWorkspaceStore((s) => s.peekFile);
  const scopeFromStore = useWorkspaceStore((s) =>
    worktreeId ? s.diffScopeByWorktree[worktreeId] : undefined,
  );

  // Peek wins over the committed activeFilePath ONLY when set AND context-matched
  // (B3): peekFile.worktreeId is the same resolved context id as this pane's
  // `worktreeId` prop (worktree id OR direct-session project id).
  const path = controlled
    ? controlled.path
    : peekFile && peekFile.worktreeId === worktreeId
      ? peekFile.path
      : storePath;

  const isExternalPeek =
    !controlled &&
    Boolean(peekFile && peekFile.worktreeId === worktreeId && peekFile.external);

  // Memoize the external object so its identity is stable across renders while
  // the underlying token/displayPath are unchanged — OutlinePanel's effects key
  // off `external?.token`, so a stable object avoids needless re-runs and the
  // infinite refetch loop a fresh-on-every-render object used to cause.
  const external = useMemo(
    () =>
      isExternalPeek && peekFile?.external
        ? {
            token: peekFile.external.token,
            displayPath: peekFile.external.displayPath,
          }
        : null,
    [isExternalPeek, peekFile?.external?.token, peekFile?.external?.displayPath]
  );

  // Project scope (direct sessions) can enter diff mode too, via the Files
  // header's "Diff view" toggle — it's always "local" there (no branch
  // concept), same source (`diffScopeByWorktree`) as worktree scope.
  const scope: DiffScope = controlled ? controlled.scope : (scopeFromStore ?? "none");

  const commitSha = controlled?.commitSha;

  // Working-tree view is plain view (scope="none"), no historical commit diff,
  // and not rendered markdown.
  const isWorkingTreeView =
    scope === "none" && !commitSha && !(path?.endsWith(".md") ?? false);

  return {
    path,
    scope,
    fileScope,
    isWorkingTreeView,
    external,
  };
}
