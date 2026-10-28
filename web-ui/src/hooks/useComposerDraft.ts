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

/** Fired (cancelable) by `appendComposerDraft`; detail `{ sessionId, text }`. */
export const COMPOSER_DRAFT_EXTERNAL_EVENT = "vst:composer-draft-external";

/**
 * Append text (draft grammar, unconverted) to a session's composer: on a new line when it is not empty. Used by
 * the review picker's row Attach, which hands its message to that agent's composer. A mounted composer for the
 * session claims the event (`preventDefault`) and inserts into its live editor, so file attachments and the
 * newest keystrokes survive (no remount, no stale localStorage read). With no composer mounted the text goes to
 * the stored draft, which the composer seeds from on mount.
 */
export function appendComposerDraft(sessionId: string, text: string): void {
  if (text.trim().length === 0) return;
  if (typeof window !== "undefined") {
    const ev = new CustomEvent(COMPOSER_DRAFT_EXTERNAL_EVENT, { detail: { sessionId, text }, cancelable: true });
    window.dispatchEvent(ev);
    if (ev.defaultPrevented) return;
  }
  const key = chatKey(sessionId);
  const existing = loadDraftGeneric(key);
  const next = existing.trim().length > 0 ? `${existing}\n${text}` : text;
  try {
    localStorage.setItem(key, next);
  } catch {
    // storage unavailable: the message just isn't carried over.
  }
}
