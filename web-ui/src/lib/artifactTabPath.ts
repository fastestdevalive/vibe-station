/**
 * The one statement of "absolute path = artifact tab": a tab/active-file path starting with `/` is read through the
 * artifact reader (or an LSP external-peek token), never a worktree-relative file. It decides LSP routing, whether
 * the repo tree expands to the file and which tab chrome shows. A future non-POSIX or `~`-relative artifact path
 * changes here, once.
 */
export function isArtifactTabPath(path: string | null | undefined): boolean {
  return path != null && path.startsWith("/");
}
