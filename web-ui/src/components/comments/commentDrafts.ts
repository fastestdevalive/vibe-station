import type { CommentAnchor } from "./types";

/**
 * Unsent comment text, kept per device in `localStorage` (never on the daemon, R45): survives a tab, rail or
 * worktree switch and a reload. Every access is wrapped: storage can be blocked, full or throw.
 */
const PREFIX = "vst-comment-draft:";
const PICKER_PREFIX = "vst-review-picker-draft:";

/** Short stable hash (djb2) of the anchor's identity: surface, side, span and quote. */
export function anchorHash(a: Pick<CommentAnchor, "surface" | "side" | "lineStart" | "lineEnd" | "quote" | "occurrence">): string {
  const s = `${a.surface}|${a.side ?? ""}|${a.lineStart ?? ""}|${a.lineEnd ?? ""}|${a.occurrence}|${a.quote}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** `vst-comment-draft:<scopeKey>:<path>:<anchorHash>` for a new comment. */
export function draftKey(scopeKey: string, path: string, hash: string): string {
  return `${PREFIX}${scopeKey}:${path}:${hash}`;
}

/** Draft of an EDIT of a saved comment (so a half-typed edit survives too). */
export function editDraftKey(scopeKey: string, commentId: string): string {
  return `${PREFIX}${scopeKey}:edit:${commentId}`;
}

export function pickerDraftKey(scopeKey: string): string {
  return `${PICKER_PREFIX}${scopeKey}`;
}

const anchorKey = (key: string) => `${key}:anchor`;

export function loadDraft(key: string): string {
  try {
    return globalThis.localStorage?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** An empty draft is removed rather than stored. */
export function saveDraft(key: string, text: string): void {
  try {
    if (text.length === 0) {
      globalThis.localStorage?.removeItem(key);
      globalThis.localStorage?.removeItem(anchorKey(key));
    } else {
      globalThis.localStorage?.setItem(key, text);
    }
  } catch {
    /* storage unavailable: the draft just doesn't survive a reload */
  }
}

export function clearDraft(key: string): void {
  saveDraft(key, "");
}

/** Remember WHERE a new-comment draft was anchored, so a reload can reopen its box (R45). */
export function saveDraftAnchor(key: string, anchor: CommentAnchor): void {
  try {
    globalThis.localStorage?.setItem(anchorKey(key), JSON.stringify(anchor));
  } catch {
    /* ignore */
  }
}

export interface StoredDraft {
  key: string;
  anchor: CommentAnchor;
  text: string;
}

/** Non-empty new-comment drafts of one file (those saved with an anchor), for reopening on mount. */
export function listPathDrafts(scopeKey: string, path: string): StoredDraft[] {
  const out: StoredDraft[] = [];
  try {
    const ls = globalThis.localStorage;
    if (!ls) return out;
    const head = `${PREFIX}${scopeKey}:${path}:`;
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (!k?.startsWith(head) || !/^[0-9a-z]+$/.test(k.slice(head.length))) continue;
      const text = ls.getItem(k) ?? "";
      const raw = ls.getItem(anchorKey(k));
      if (!text || !raw) continue;
      try {
        out.push({ key: k, anchor: JSON.parse(raw) as CommentAnchor, text });
      } catch {
        /* one corrupt anchor must not hide the file's other drafts */
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}
