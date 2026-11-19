import { DEFAULT_GLOBAL_DRAFT_CONFIG, useGlobalDraftStore } from "@/store/globalDraftStore";
import { GLOBAL_NEW_SCOPE } from "./constants";
import type { DraftTextEngine } from "./engine";

/**
 * Decision 10: the Tier-2 (`global-new`) draft has ONE source of truth — the
 * server-owned `draft_texts` row. This mirror keeps `useGlobalDraftStore` (what
 * the sidebar renders) in step with it, and turns a discard into a server clear:
 *
 * - a non-empty `global-new` doc/event → `setDraft` (keeping any known config,
 *   else the default);
 * - a doc/event with `text: ""` → `clearDraft`;
 * - the store's draft going non-null → null (a discard) → `engine.clear`, which
 *   is a no-op when the scope is already empty.
 *
 * It acts only on actual docs/events for `global-new`, never on absence from
 * the list — a scope the server never sent must not wipe a local draft.
 *
 * Started once per engine by `ensureDraftTextSync` (Decision 9).
 */
export function startGlobalDraftMirror(engine: DraftTextEngine): () => void {
  const binding = engine.bind(GLOBAL_NEW_SCOPE, (text) => {
    const state = useGlobalDraftStore.getState();
    if (text === "") {
      if (state.draft !== null) state.clearDraft();
      return;
    }
    state.setDraft({
      draftPrompt: text,
      draftConfig: state.draft?.draftConfig ?? DEFAULT_GLOBAL_DRAFT_CONFIG,
    });
  });

  let previous = useGlobalDraftStore.getState().draft;
  const unsubscribe = useGlobalDraftStore.subscribe((state) => {
    const next = state.draft;
    if (previous !== null && next === null) engine.clear(GLOBAL_NEW_SCOPE);
    previous = next;
  });

  return () => {
    unsubscribe();
    binding.dispose();
  };
}
