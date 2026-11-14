import type { DetailsTarget } from "./detailsStore";
import type { FileStat } from "@/api/types";

/** Absolute path to copy. SYNCHRONOUS on purpose: call it inside the click handler, never after an await. */
export function resolveCopyPath(target: DetailsTarget, stat?: FileStat | null): string {
  if (target.artifact) return target.artifact.path;
  return stat?.absolutePath ?? target.path;
}

/** Repo-relative path to copy (artifacts: the row's display path). Synchronous, see resolveCopyPath. */
export function resolveRelativePath(target: DetailsTarget): string {
  return target.artifact?.displayPath ?? target.path;
}
