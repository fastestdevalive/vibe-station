import { create } from "zustand";
import type { ArtifactRow, FileScope, GitStatusChar } from "@/api/types";

/** Git facts the opener already has (Changes rows, commit files, tree rows with status). Never fetched here. */
export interface DetailsGitInfo {
  status: GitStatusChar;
  insertions?: number;
  deletions?: number;
  /** "HEAD", "main", or "commit" (commit files). */
  baseLabel?: string;
}

/** What the Details popup describes. `path` is repo-relative in-root, or the artifact row's canonical path. */
export interface DetailsTarget {
  scope: FileScope;
  scopeId: string;
  path: string;
  name: string;
  isDir?: boolean;
  artifact?: ArtifactRow;
  git?: DetailsGitInfo;
}

interface DetailsState {
  target: DetailsTarget | null;
  open: (target: DetailsTarget) => void;
  close: () => void;
}

/** Single Details target; `FileDetailsHost` (mounted once in ToolPanel) renders it. */
export const useDetailsStore = create<DetailsState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
