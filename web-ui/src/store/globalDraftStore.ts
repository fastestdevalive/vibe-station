import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DraftConfig } from "@/api/types";

/** The config a Tier-2 draft falls back to when the mirror creates the row from
 *  a server doc and no local config is known yet (Decision 10). */
export const DEFAULT_GLOBAL_DRAFT_CONFIG: DraftConfig = { entryPoint: "global" };

/**
 * Tier 2 (global-new) draft state — the client-side draft that has no
 * project/worktree selected yet, so there is no server session record. The
 * draft TEXT itself is server-owned (`draft_texts` scope `global-new`, mirrored
 * by `draftsync/globalDraftMirror.ts`); this store keeps only the config and
 * what the mirror last wrote, so the sidebar row and the composer share one
 * reactive value.
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
      // Decision 10: the prompt has ONE source of truth (the server-owned
      // `global-new` draft). Persisting it would resurrect a cleared draft after
      // a reload — the store only keeps the device/UI choice (the config).
      partialize: (s) => ({
        draft: s.draft ? { draftPrompt: "", draftConfig: s.draft.draftConfig } : null,
      }),
    },
  ),
);
