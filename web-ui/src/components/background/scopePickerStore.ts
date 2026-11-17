import { create } from "zustand";
import type { ScopeKey } from "./backgroundStore";

/**
 * UI-only: which worktree/project the scope picker dialog is open for.
 * Nothing here is persisted — the wallpaper values themselves live in
 * `backgroundStore`.
 */
export interface ScopePickerTarget {
  scope: ScopeKey;
  label: string;
  kind: "worktree" | "project";
}

interface ScopePickerState {
  open: ScopePickerTarget | null;
  show(target: ScopePickerTarget): void;
  close(): void;
}

export const useScopePickerStore = create<ScopePickerState>((set) => ({
  open: null,
  show: (target) => set({ open: target }),
  close: () => set({ open: null }),
}));
