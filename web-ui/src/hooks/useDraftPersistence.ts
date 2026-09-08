import { useEffect, useRef } from "react";

/** Generic keyed draft persistence (localStorage, debounced writes).
 *  Extracted from `useComposerDraft` (Decision 1) so any caller can persist a
 *  single string value under a full storage key — the caller owns key
 *  composition (e.g. `vst-chat-draft-${sessionId}`, `vst-newagent-draft-${projectId}`). */

const SAVE_DEBOUNCE_MS = 400;

/** Read a stored draft for a key. Module fn so callers can seed a `useState`
 *  initializer synchronously. Any failure → "". */
export function loadDraft(key: string): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(key: string, text: string): void {
  try {
    if (text.trim().length === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, text);
    }
  } catch {
    // storage unavailable (private mode / quota) — drafts are best-effort.
  }
}

/** Debounced draft writer for one storage key. `save` coalesces keystrokes;
 *  `clear` drops the key immediately; unmount flushes any pending write. */
export function useDraftPersistence(key: string) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ text: string } | null>(null);

  // Keep the latest key available to the unmount flush without re-running
  // the cleanup effect on every keystroke.
  const keyRef = useRef(key);
  keyRef.current = key;

  function save(text: string) {
    pending.current = { text };
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (pending.current !== null) {
        writeDraft(keyRef.current, pending.current.text);
        pending.current = null;
      }
    }, SAVE_DEBOUNCE_MS);
  }

  function clear() {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    pending.current = null;
    writeDraft(keyRef.current, "");
  }

  // Flush a pending write synchronously on unmount (component-swap only; skip
  // `beforeunload` — a full reload with an unsaved keystroke is acceptable loss).
  useEffect(() => {
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (pending.current !== null) {
        writeDraft(keyRef.current, pending.current.text);
        pending.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { save, clear };
}
