import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DraftConfig } from "@/api/types";

/**
 * Tier 2 (global-new) draft state — the client-side-only draft that has no
 * project/worktree selected yet, so there is no server session record. Persisted
 * to localStorage so it survives navigation within the same tab.
 *
 * Only global-new drafts (entryPoint "global", no project picked yet) live here.
 * Tier 1 drafts (project/worktree/tab known at click time) are server-persisted
 * sessions in `useServerStore` and never touch this store.
 *
 * Using a Zustand slice (rather than reading/writing localStorage directly)
 * because a raw localStorage write in DraftComposer does not trigger a re-render
 * in LeftSidebar — a shared reactive store is the one place both can subscribe.
 */
export interface GlobalDraftState {
  /** The current Tier 2 draft, or null when none exists. */
  draft: { draftPrompt: string; draftConfig: DraftConfig } | null;
  setDraft: (d: GlobalDraftState["draft"]) => void;
  clearDraft: () => void;
}

export const useGlobalDraftStore = create<GlobalDraftState>()(
  persist(
    (set) => ({
      draft: null,
      setDraft: (draft) => set({ draft }),
      clearDraft: () => set({ draft: null }),
    }),
    {
      name: "vst-global-draft",
    },
  ),
);
