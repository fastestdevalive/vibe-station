import type { CommentRestoreReason, ReviewComment, ReviewSummary } from "@/api/types";
import { useMemo } from "react";
import { useCommentStore, type CommentScopeState } from "./useCommentStore";

const NONE: ReviewComment[] = [];

/** Comments of one file, in pin order. */
export function commentsForPath(comments: readonly ReviewComment[], path: string): ReviewComment[] {
  return comments.filter((c) => c.path === path);
}

/** Pin count per path (the changed-file row chip), counting every comment in the scope. */
export function countsByPath(comments: readonly ReviewComment[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of comments) out.set(c.path, (out.get(c.path) ?? 0) + 1);
  return out;
}

/** In the panel and not attached to any composer. */
export const unsentComments = (comments: readonly ReviewComment[]) => comments.filter((c) => !c.attachedTo);

/** Attached to this composer (`session:<id>`), or to any composer when `key` is omitted. */
export const attachedComments = (comments: readonly ReviewComment[], key?: string) =>
  comments.filter((c) => (key ? c.attachedTo === key : !!c.attachedTo));

export interface RestoredGroup {
  reason: CommentRestoreReason;
  ids: string[];
}

/** Restored comments grouped by why they came back (one tray notice per reason). */
export function restoredGroups(comments: readonly ReviewComment[]): RestoredGroup[] {
  const groups = new Map<CommentRestoreReason, string[]>();
  for (const c of comments) {
    if (!c.restoredReason) continue;
    const ids = groups.get(c.restoredReason) ?? [];
    ids.push(c.id);
    groups.set(c.restoredReason, ids);
  }
  return [...groups].map(([reason, ids]) => ({ reason, ids }));
}

/** The 1-based position of a comment among its scope's comments (`Comment 3 of 5`). */
export function pinOrdinal(comments: readonly ReviewComment[], id: string): { index: number; total: number } {
  const i = comments.findIndex((c) => c.id === id);
  return { index: i + 1, total: comments.length };
}

/** `useCommentStore` slice for one scope (undefined until requested). */
export function useCommentScope(scopeId: string | null | undefined): CommentScopeState | undefined {
  return useCommentStore((s) => (scopeId ? s.byScope[scopeId] : undefined));
}

/** Stable comment list for a scope (same array until it changes). */
export function useScopeComments(scopeId: string | null | undefined): ReviewComment[] {
  return useCommentStore((s) => (scopeId ? s.byScope[scopeId]?.comments : undefined)) ?? NONE;
}

/** Comments of one file in a scope, memoised on the scope's list. */
export function usePathComments(scopeId: string | null | undefined, path: string | null | undefined): ReviewComment[] {
  const all = useScopeComments(scopeId);
  return useMemo(() => (path ? commentsForPath(all, path) : NONE), [all, path]);
}

/** Total comments in a scope (the rail badge). */
export function useCommentCount(scopeId: string | null | undefined): number {
  return useCommentStore((s) => (scopeId ? (s.byScope[scopeId]?.comments.length ?? 0) : 0));
}

/** `N comments · M files` of these ids as the store holds them now (the queued card's summary before the daemon echoes it). */
export function summarizeReview(comments: readonly ReviewComment[], ids: readonly string[]): ReviewSummary {
  const hit = new Set(ids);
  const rows = comments.filter((c) => hit.has(c.id));
  return { count: rows.length || ids.length, files: new Set(rows.map((c) => c.path)).size };
}

const lineOf = (c: ReviewComment) => c.current?.start ?? c.lineStart ?? c.newStart ?? c.oldStart ?? 0;

/** Sorted by file, then line, then pin (the list's order and the order of a send, R60). */
export function sortForList(comments: readonly ReviewComment[]): ReviewComment[] {
  return comments.slice().sort((a, b) => a.path.localeCompare(b.path) || lineOf(a) - lineOf(b) || a.pin - b.pin);
}

/** `L129` / `L132–136` for a comment's current span; null for a quote-only comment. */
export function commentLineLabel(c: ReviewComment): string | null {
  const start = c.current?.start ?? c.lineStart ?? c.newStart ?? c.oldStart;
  if (start == null) return null;
  const end = c.current?.end ?? c.lineEnd ?? c.newEnd ?? c.oldEnd ?? start;
  return end > start ? `L${start}–${end}` : `L${start}`;
}

/** Why a comment can't be re-checked (list row copy; the tooltip of the watch-limit case adds "(watch limit)"). */
export function cantCheckCopy(c: ReviewComment): { text: string; title: string } | null {
  if (c.anchor !== "cant_check") return null;
  if (c.anchorReason === "watch_limit") return { text: "Can't check · too many watched files", title: "Can't check · too many watched files (watch limit)" };
  return { text: "Can't check · file too large", title: "Can't check · file too large" };
}
