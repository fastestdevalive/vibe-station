import { GLOBAL_NEW_SCOPE } from "./constants";

/**
 * One-time import of the pre-sync localStorage drafts (Decision 7): until the
 * marker exists, a first paint still shows the legacy text (`legacyTextFor`),
 * and after the first successful bulk fetch every legacy key whose server row is
 * still empty is pushed to the daemon. Then the keys are deleted and the marker
 * is written — a cleared draft is never resurrected.
 */

/** Written once the import has run; presence means "never look at the legacy keys again". */
export const LEGACY_MIGRATION_MARKER = "vst-draft-sync-migrated-v1";

const CHAT_PREFIX = "vst-chat-draft-";
const PICKER_PREFIX = "vst-review-picker-draft:";
const PICKER_SCOPE_PREFIX = "review-picker:";
const GLOBAL_DRAFT_KEY = "vst-global-draft";

/** What `migrateLegacy` needs from the engine (kept narrow so it can be faked). */
export interface LegacyImportTarget {
  /** The raw Tier-2 prompt captured synchronously when the engine was created. */
  readonly globalPromptSnapshot: string | null;
  /** The server's text for a scope; "" for an absent row. */
  serverText(scope: string): string;
  /** Show `text` on every binding of that scope and PUT it now. */
  importLocal(scope: string, text: string): void;
}

function readKey(key: string): string {
  if (typeof localStorage === "undefined") return "";
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // storage unavailable: the marker below still stops a re-run.
  }
}

/** The pre-sync draft for a scope, for the first paint only (never after the marker). */
export function legacyTextFor(scope: string): string {
  if (scope === GLOBAL_NEW_SCOPE) return readGlobalPrompt();
  if (scope.startsWith(PICKER_SCOPE_PREFIX)) return readKey(PICKER_PREFIX + scope.slice(PICKER_SCOPE_PREFIX.length));
  return readKey(CHAT_PREFIX + scope);
}

/** The Tier-2 prompt inside the zustand-persisted `vst-global-draft` value. */
function readGlobalPrompt(): string {
  const raw = readKey(GLOBAL_DRAFT_KEY);
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { state?: { draft?: { draftPrompt?: unknown } } } | null;
    const prompt = parsed?.state?.draft?.draftPrompt;
    return typeof prompt === "string" ? prompt : "";
  } catch {
    return "";
  }
}

/** Every legacy draft key present in this browser, with its draft scope. */
function legacyEntries(): Array<{ key: string; scope: string }> {
  if (typeof localStorage === "undefined") return [];
  const out: Array<{ key: string; scope: string }> = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key.startsWith(CHAT_PREFIX) && key.length > CHAT_PREFIX.length) {
        out.push({ key, scope: key.slice(CHAT_PREFIX.length) });
      } else if (key.startsWith(PICKER_PREFIX) && key.length > PICKER_PREFIX.length) {
        out.push({ key, scope: PICKER_SCOPE_PREFIX + key.slice(PICKER_PREFIX.length) });
      }
    }
  } catch {
    return out;
  }
  return out;
}

/** Keep the Tier-2 draft config (a device/UI choice) and drop its prompt. */
function rewriteGlobalDraft(): void {
  const raw = readKey(GLOBAL_DRAFT_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as { state?: { draft?: { draftConfig?: unknown } } } | null;
    const draft = parsed?.state?.draft;
    if (!draft) {
      removeKey(GLOBAL_DRAFT_KEY);
      return;
    }
    localStorage.setItem(
      GLOBAL_DRAFT_KEY,
      JSON.stringify({ ...parsed, state: { ...parsed?.state, draft: { draftPrompt: "", draftConfig: draft.draftConfig } } }),
    );
  } catch {
    // A corrupt legacy value cannot keep a prompt alive; drop it.
    removeKey(GLOBAL_DRAFT_KEY);
  }
}

/** Run once, after the first successful bulk fetch (no-op once the marker exists). */
export function migrateLegacy(target: LegacyImportTarget): void {
  if (typeof localStorage === "undefined") return;
  if (readKey(LEGACY_MIGRATION_MARKER) !== "") return;

  const entries = legacyEntries();
  for (const { key, scope } of entries) {
    const text = readKey(key);
    if (text.trim() !== "" && target.serverText(scope) === "") target.importLocal(scope, text);
  }
  for (const { key } of entries) removeKey(key);

  const prompt = target.globalPromptSnapshot ?? "";
  if (prompt.trim() !== "" && target.serverText(GLOBAL_NEW_SCOPE) === "") {
    target.importLocal(GLOBAL_NEW_SCOPE, prompt);
  }
  rewriteGlobalDraft();

  try {
    localStorage.setItem(LEGACY_MIGRATION_MARKER, "1");
  } catch {
    // No marker means the import runs again next load; every key is empty now,
    // so a re-run imports nothing.
  }
}
