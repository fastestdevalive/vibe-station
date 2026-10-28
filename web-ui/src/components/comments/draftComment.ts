import type { ArtifactScopeKind, CommentPathKind, CreateCommentRequest, ReviewComment } from "@/api/types";
import type { CommentAnchor } from "./types";

/** Id of the virtual comment that stands for the open "new comment" box while it is being typed. */
export const DRAFT_ID = "__draft__";

/**
 * The open `new` anchor as a comment-shaped value, so the row / markdown mark passes highlight its span
 * (dashed `.comment-hl--draft`) and the pin measurer draws a draft pin at its end. Never stored, never listed.
 */
export function draftFromAnchor(
  a: CommentAnchor,
  scope: { scopeKind: ArtifactScopeKind; scopeId: string; path: string; pathKind: CommentPathKind },
): ReviewComment {
  return {
    ...scope,
    id: DRAFT_ID,
    pin: 0,
    surface: a.surface,
    diffScope: a.diffScope,
    side: a.side,
    lineStart: a.lineStart,
    lineEnd: a.lineEnd,
    quote: a.quote,
    prefix: a.prefix,
    suffix: a.suffix,
    occurrence: a.occurrence,
    text: "",
    anchor: "anchored",
    blockBytes: 0,
    version: 0,
    createdAt: "",
    updatedAt: "",
  };
}

/**
 * `POST /comments` body for a comment: an explicit allowlist of the `CreateCommentRequest` keys, so a new
 * server-computed `ReviewComment` field (a count, a flag) can never leak into the request by accident.
 * Optional anchor fields are copied only when set.
 */
export function requestFromComment(
  c: Pick<ReviewComment, "id" | "path" | "pathKind" | "surface" | "quote" | "prefix" | "suffix" | "occurrence"> &
    Partial<Pick<ReviewComment, "diffScope" | "baseSha" | "side" | "lineStart" | "lineEnd" | "oldStart" | "oldEnd" | "newStart" | "newEnd">>,
  text: string,
  restorePin?: number,
): CreateCommentRequest {
  const req: CreateCommentRequest = {
    id: c.id,
    path: c.path,
    pathKind: c.pathKind,
    surface: c.surface,
    quote: c.quote,
    prefix: c.prefix,
    suffix: c.suffix,
    occurrence: c.occurrence,
    text,
  };
  if (c.diffScope !== undefined) req.diffScope = c.diffScope;
  if (c.baseSha !== undefined) req.baseSha = c.baseSha;
  if (c.side !== undefined) req.side = c.side;
  if (c.lineStart !== undefined) req.lineStart = c.lineStart;
  if (c.lineEnd !== undefined) req.lineEnd = c.lineEnd;
  if (c.oldStart !== undefined) req.oldStart = c.oldStart;
  if (c.oldEnd !== undefined) req.oldEnd = c.oldEnd;
  if (c.newStart !== undefined) req.newStart = c.newStart;
  if (c.newEnd !== undefined) req.newEnd = c.newEnd;
  if (restorePin !== undefined) req.restorePin = restorePin;
  return req;
}
