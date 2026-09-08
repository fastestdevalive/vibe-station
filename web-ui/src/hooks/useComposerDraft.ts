import { loadDraft as loadDraftGeneric, useDraftPersistence } from "./useDraftPersistence";

/** Per-session composer draft persistence (localStorage, debounced writes).
 *  Thin wrapper over `useDraftPersistence` (Decision 1) — key precedent:
 *  `vst-last-model-${cli}` (ModelPicker). */

const chatKey = (sessionId: string) => `vst-chat-draft-${sessionId}`;

export function loadDraft(sessionId: string): string {
  return loadDraftGeneric(chatKey(sessionId));
}

export function useComposerDraft(sessionId: string) {
  return useDraftPersistence(chatKey(sessionId));
}
