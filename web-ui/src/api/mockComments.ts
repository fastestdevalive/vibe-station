import { MAX_COMMENTS, MAX_QUOTE_BYTES, MAX_TEXT_BYTES } from "@/components/comments/reviewLimits";
import { ReviewApiError } from "./errors";
import type {
  ArtifactScopeKind,
  AttachCommentsRequest,
  AttachCommentsResponse,
  CommentErrorCode,
  CommentListResponse,
  CommentRestoreReason,
  CreateCommentRequest,
  CreateTerminalDeliveryRequest,
  CreateTerminalDeliveryResponse,
  DetachCommentsRequest,
  DetachCommentsResponse,
  DismissRestoredResponse,
  PatchCommentRequest,
  RenderCommentsRequest,
  RenderCommentsResponse,
  RestoreReviewResponse,
  ReviewComment,
  ReviewCommentSnapshot,
  ReviewRecord,
  TerminalDelivery,
  TerminalDeliveryState,
  TerminalReadiness,
  WSEvent,
} from "./types";

const CAP = MAX_COMMENTS;
const MAX_TEXT = MAX_TEXT_BYTES;
const MAX_QUOTE = MAX_QUOTE_BYTES;

const byteLen = (s: string) => new TextEncoder().encode(s).length;
const fail = (status: number, code: CommentErrorCode, message: string, info: ReviewApiError["info"] = {}) =>
  new ReviewApiError(message, status, code, info);

/** `   Label: value`, or `   Label:` plus `   | ` lines for a multi-line body (mirrors review_format.rs). */
function bodyLines(label: string, raw: string, quoted: boolean): string[] {
  const b = raw.replace(/\n+$/, "");
  if (b.includes("\n")) return [`   ${label}:`, ...b.split("\n").map((l) => `   | ${l}`)];
  if (quoted) return [`   ${label}: "${b.replace(/"/g, '\\"')}"`];
  return [b ? `   ${label}: ${b}` : `   ${label}:`];
}

/** The Appendix A block as the daemon renders it, so mock "Copy as text" round-trips through `parseReviewText`. */
function renderBlock(name: string, comments: ReviewComment[]): string {
  const sorted = [...comments].sort(
    (a, b) => a.path.localeCompare(b.path) || (a.current?.start ?? a.lineStart ?? 0) - (b.current?.start ?? b.lineStart ?? 0) || a.pin - b.pin,
  );
  const out: string[] = [name ? `Review comments (${sorted.length}) · ${name}` : `Review comments (${sorted.length})`];
  for (const c of sorted) {
    const suffix = c.anchor === "outdated" ? " (outdated)" : c.anchor === "file_missing" ? " (file no longer exists)" : "";
    out.push("", `${c.pin}) File: ${c.path}${suffix}`);
    const meta: string[] = [];
    const start = c.lineStart;
    if (start != null) {
      const end = c.lineEnd ?? start;
      meta.push(end === start ? `Lines: ${start}` : `Lines: ${start}–${end}`);
    }
    if (c.side) meta.push(`Side: ${c.side}`);
    if (c.diffScope) meta.push(`Scope: ${c.diffScope} changes`);
    if (meta.length) out.push(`   ${meta.join("   ")}`);
    if (c.quote) out.push(...bodyLines("Quote", c.quote, true));
    out.push(...bodyLines("Comment", c.text, false));
  }
  return out.join("\n");
}

/** Snapshot of a comment (what a sent turn / delivery keeps so it can be restored). */
function snapshotOf(c: ReviewComment): ReviewCommentSnapshot {
  const lines = c.lineStart != null ? { start: c.lineStart, end: c.lineEnd ?? c.lineStart } : undefined;
  return {
    id: c.id,
    pin: c.pin,
    path: c.path,
    pathKind: c.pathKind,
    surface: c.surface,
    diffScope: c.diffScope,
    side: c.side,
    lines,
    quote: c.quote,
    text: c.text,
    anchor: c.anchor,
    anchorReason: c.anchorReason,
    baseSha: c.baseSha,
    oldStart: c.oldStart,
    oldEnd: c.oldEnd,
    newStart: c.newStart,
    newEnd: c.newEnd,
    lineStart: c.lineStart,
    lineEnd: c.lineEnd,
    prefix: c.prefix,
    suffix: c.suffix,
    occurrence: c.occurrence,
    movedFrom: c.movedFrom,
    createdAt: c.createdAt,
  };
}

interface ScopeData {
  scopeKind: ArtifactScopeKind;
  comments: ReviewComment[];
}

/** Daemon rule: highest existing pin + 1, or 1 for an empty scope (a send empties it, so numbering restarts). */
const nextPinOf = (s: ScopeData): number => s.comments.reduce((m, c) => Math.max(m, c.pin), 0) + 1;

/**
 * In-memory review-comment API for mock mode and tests. Mirrors the daemon contract (caps, error codes,
 * attach leases without expiry) and pushes `comments:changed` / `terminal-delivery:updated` the way the
 * daemon does, so `useCommentStore` behaves identically against it.
 */
export function createMockComments(emit: (ev: WSEvent) => void, nameFor: (scopeId: string) => string = (id) => id) {
  const scopes = new Map<string, ScopeData>();
  /** Snapshots a sent turn kept, by `sessionId:turnId` (the "Restore to comments" source). */
  const sentTurns = new Map<string, { scopeId: string; scopeKind: ArtifactScopeKind; snapshots: ReviewCommentSnapshot[] }>();
  const deliveries = new Map<string, { delivery: TerminalDelivery; snapshots: ReviewCommentSnapshot[] }>();
  let seq = 0;

  const scopeOf = (kind: ArtifactScopeKind, id: string): ScopeData => {
    let s = scopes.get(id);
    if (!s) {
      s = { scopeKind: kind, comments: [] };
      scopes.set(id, s);
    }
    return s;
  };
  const find = (id: string) => {
    for (const [scopeId, s] of scopes) {
      const c = s.comments.find((x) => x.id === id);
      if (c) return { scopeId, s, c };
    }
    return null;
  };
  const changed = (
    scopeId: string,
    s: ScopeData,
    upserted: ReviewComment[],
    deleted: Array<{ id: string; reason: "deleted" | "sent" | "scheduled" }> = [],
  ) => emit({ type: "comments:changed", scopeKind: s.scopeKind, scopeId, upserted: structuredClone(upserted), deleted });
  const now = () => new Date().toISOString();

  /** Re-insert snapshots (INSERT OR IGNORE by pin and id), attachedTo cleared. */
  function restore(scopeId: string, kind: ArtifactScopeKind, snaps: ReviewCommentSnapshot[], reason: CommentRestoreReason) {
    const s = scopeOf(kind, scopeId);
    const back: ReviewComment[] = [];
    let skipped = 0;
    for (const snap of snaps) {
      if (s.comments.some((c) => c.id === snap.id || c.pin === snap.pin)) {
        skipped += 1;
        continue;
      }
      const c: ReviewComment = {
        id: snap.id,
        scopeKind: kind,
        scopeId,
        pin: snap.pin, // a taken pin was skipped above
        path: snap.path,
        pathKind: snap.pathKind,
        surface: snap.surface,
        diffScope: snap.diffScope,
        baseSha: snap.baseSha,
        side: snap.side,
        lineStart: snap.lineStart ?? snap.lines?.start,
        lineEnd: snap.lineEnd ?? snap.lines?.end,
        oldStart: snap.oldStart,
        oldEnd: snap.oldEnd,
        newStart: snap.newStart,
        newEnd: snap.newEnd,
        quote: snap.quote,
        prefix: snap.prefix ?? "",
        suffix: snap.suffix ?? "",
        occurrence: snap.occurrence ?? 0,
        text: snap.text,
        anchor: snap.anchor,
        anchorReason: snap.anchorReason,
        movedFrom: snap.movedFrom,
        restoredReason: reason,
        blockBytes: byteLen(snap.quote) + byteLen(snap.text) + 64,
        version: 1,
        createdAt: snap.createdAt ?? now(),
        updatedAt: now(),
      };
      s.comments.push(c);
      back.push(c);
    }
    if (back.length) changed(scopeId, s, back);
    return { restored: back.length, skipped };
  }

  function takeIds(scopeId: string, ids: string[], reason: "sent" | "scheduled") {
    const s = scopes.get(scopeId);
    const taken = s ? s.comments.filter((c) => ids.includes(c.id)) : [];
    if (!s || taken.length !== ids.length) {
      throw fail(409, "comments_changed", "Some comments changed", { remaining: taken.length });
    }
    s.comments = s.comments.filter((c) => !ids.includes(c.id));
    changed(scopeId, s, [], taken.map((c) => ({ id: c.id, reason })));
    return taken.map(snapshotOf);
  }

  function pushDelivery(d: TerminalDelivery) {
    emit({ type: "terminal-delivery:updated", delivery: structuredClone(d) });
  }

  return {
    async listComments(
      scopeId: string,
      scopeKind: ArtifactScopeKind = "worktree",
      opts: { path?: string; delivery?: "unsent" | "all" } = {},
    ): Promise<CommentListResponse> {
      const s = scopeOf(scopeKind, scopeId);
      let rows = s.comments;
      if (opts.path) rows = rows.filter((c) => c.path === opts.path);
      if (opts.delivery === "unsent") rows = rows.filter((c) => !c.attachedTo);
      const live = [...deliveries.values()]
        .map((d) => d.delivery)
        .filter((d) => d.scopeId === scopeId && (d.state === "waiting" || d.state === "pasting"));
      return structuredClone({ comments: rows, nextPin: nextPinOf(s), terminalDeliveries: live });
    },

    async createComment(scopeId: string, scopeKind: ArtifactScopeKind, body: CreateCommentRequest): Promise<ReviewComment> {
      const s = scopeOf(scopeKind, scopeId);
      const existing = s.comments.find((c) => c.id === body.id);
      if (existing) return structuredClone(existing);
      if (s.comments.length >= CAP) throw fail(409, "cap_reached", "Limit reached");
      if (byteLen(body.text) > MAX_TEXT) throw fail(413, "text_too_long", "Comment is too long");
      if (byteLen(body.quote) > MAX_QUOTE) throw fail(413, "quote_too_long", "Quote is too long");
      let pin = nextPinOf(s);
      if (body.restorePin != null && !s.comments.some((c) => c.pin === body.restorePin)) pin = body.restorePin;
      const { restorePin: _unused, ...fields } = body;
      void _unused;
      const c: ReviewComment = {
        ...fields,
        scopeKind,
        scopeId,
        pin,
        lineEnd: body.lineEnd ?? body.lineStart,
        anchor: "anchored",
        blockBytes: byteLen(body.quote) + byteLen(body.text) + 64,
        version: 1,
        createdAt: now(),
        updatedAt: now(),
      };
      s.comments.push(c);
      changed(scopeId, s, [c]);
      return structuredClone(c);
    },

    async patchComment(id: string, body: PatchCommentRequest): Promise<ReviewComment> {
      const hit = find(id);
      if (!hit) throw fail(404, "not_found", "Comment not found");
      if (byteLen(body.text) > MAX_TEXT) throw fail(413, "text_too_long", "Comment is too long");
      hit.c.text = body.text;
      hit.c.version += 1;
      hit.c.updatedAt = now();
      hit.c.blockBytes = byteLen(hit.c.quote) + byteLen(body.text) + 64;
      changed(hit.scopeId, hit.s, [hit.c]);
      return structuredClone(hit.c);
    },

    async deleteComment(id: string): Promise<{ ok: true }> {
      const hit = find(id);
      if (!hit) throw fail(404, "not_found", "Comment not found");
      hit.s.comments = hit.s.comments.filter((c) => c.id !== id);
      changed(hit.scopeId, hit.s, [], [{ id, reason: "deleted" }]);
      return { ok: true };
    },

    async attachComments(scopeId: string, scopeKind: ArtifactScopeKind, body: AttachCommentsRequest): Promise<AttachCommentsResponse> {
      const s = scopeOf(scopeKind, scopeId);
      if (!body.composerKey.startsWith("session:")) throw fail(400, "invalid_composer", "Bad composer key");
      if (body.refreshOnly) return { attached: s.comments.filter((c) => c.attachedTo === body.composerKey).map((c) => c.id) };
      const targets = s.comments.filter((c) => !body.commentIds || body.commentIds.includes(c.id));
      const moved = targets.filter((c) => c.attachedTo !== body.composerKey);
      for (const c of moved) {
        c.attachedTo = body.composerKey;
      }
      if (moved.length) changed(scopeId, s, moved);
      return { attached: targets.map((c) => c.id) };
    },

    async detachComments(scopeId: string, scopeKind: ArtifactScopeKind, body: DetachCommentsRequest): Promise<DetachCommentsResponse> {
      const s = scopeOf(scopeKind, scopeId);
      const targets = s.comments.filter(
        (c) =>
          c.attachedTo &&
          (!body.composerKey || c.attachedTo === body.composerKey) &&
          (!body.commentIds || body.commentIds.includes(c.id)),
      );
      for (const c of targets) delete c.attachedTo;
      if (targets.length) changed(scopeId, s, targets);
      return { detached: targets.map((c) => c.id) };
    },

    async renderComments(scopeId: string, scopeKind: ArtifactScopeKind, body: RenderCommentsRequest): Promise<RenderCommentsResponse> {
      const s = scopeOf(scopeKind, scopeId);
      const rows = s.comments.filter((c) => !body.commentIds || body.commentIds.includes(c.id));
      const block = renderBlock(nameFor(scopeId), rows);
      const text = body.message?.trim() ? `${body.message.trim()}\n\n${block}` : block;
      return { text, bytes: byteLen(text), count: rows.length };
    },

    async dismissRestoredComments(scopeId: string, scopeKind: ArtifactScopeKind): Promise<DismissRestoredResponse> {
      const s = scopeOf(scopeKind, scopeId);
      const cleared = s.comments.filter((c) => c.restoredReason);
      for (const c of cleared) delete c.restoredReason;
      if (cleared.length) changed(scopeId, s, cleared);
      return { cleared: cleared.length };
    },

    async restoreReview(sessionId: string, turnId: string): Promise<RestoreReviewResponse> {
      const sent = sentTurns.get(`${sessionId}:${turnId}`);
      if (!sent) throw fail(409, "not_found", "Nothing to restore");
      return restore(sent.scopeId, sent.scopeKind, sent.snapshots, "turn_cancelled");
    },

    async createTerminalDelivery(
      scopeId: string,
      scopeKind: ArtifactScopeKind,
      body: CreateTerminalDeliveryRequest,
    ): Promise<CreateTerminalDeliveryResponse> {
      const busy = [...deliveries.values()].some(
        (d) => d.delivery.sessionId === body.sessionId && (d.delivery.state === "waiting" || d.delivery.state === "pasting"),
      );
      if (busy) throw fail(409, "delivery_in_flight", "A send to this agent is already in flight");
      const snapshots = takeIds(scopeId, body.commentIds, "sent");
      const delivery: TerminalDelivery = {
        id: body.terminalDeliveryId,
        scopeKind,
        scopeId,
        sessionId: body.sessionId,
        state: "waiting",
        commentIds: body.commentIds,
        commentCount: body.commentIds.length,
        bytes: snapshots.reduce((n, c) => n + byteLen(c.quote) + byteLen(c.text) + 64, 0),
        ...(body.message ? { message: body.message } : {}),
        updatedAt: now(),
      };
      deliveries.set(delivery.id, { delivery, snapshots });
      pushDelivery(delivery);
      return { delivery: structuredClone(delivery) };
    },

    async cancelTerminalDelivery(id: string): Promise<{ ok: true }> {
      const d = deliveries.get(id);
      if (!d) throw fail(404, "not_found", "Delivery not found");
      if (d.delivery.state === "pasting") throw fail(409, "delivery_pasting", "Already pasting");
      d.delivery = { ...d.delivery, state: "cancelled", updatedAt: now() };
      restore(d.delivery.scopeId, d.delivery.scopeKind, d.snapshots, "send_cancelled");
      pushDelivery(d.delivery);
      return { ok: true };
    },

    async terminalReadiness(sessionId: string): Promise<TerminalReadiness> {
      void sessionId;
      return "ready";
    },

    /** Test / dev-panel seams (not part of the daemon contract). */
    __comments: {
      /** Consume comments for a Rich Chat turn (the mock `sendChat` / `scheduleMessage` call this). */
      takeForTurn(
        scopeId: string,
        ids: string[],
        sessionId: string,
        turnId: string,
        reason: "sent" | "scheduled" = "sent",
      ): ReviewRecord {
        const snapshots = takeIds(scopeId, ids, reason);
        const kind = scopes.get(scopeId)?.scopeKind ?? "worktree";
        sentTurns.set(`${sessionId}:${turnId}`, { scopeId, scopeKind: kind, snapshots });
        return { name: nameFor(scopeId), comments: structuredClone(snapshots) };
      },
      /** Scope that owns these ids (a chat send names only ids). */
      scopeOfComment(id: string): string | null {
        return find(id)?.scopeId ?? null;
      },
      /** Move a delivery through the daemon's phases / outcomes. */
      setDeliveryState(id: string, state: TerminalDeliveryState, reason?: string) {
        const d = deliveries.get(id);
        if (!d) return;
        d.delivery = { ...d.delivery, state, ...(reason ? { reason } : {}), updatedAt: now() };
        if (state === "timed_out" || state === "failed") {
          restore(d.delivery.scopeId, d.delivery.scopeKind, d.snapshots, state === "timed_out" ? "timed_out" : "send_failed");
        }
        pushDelivery(d.delivery);
      },
      /** Put a sent turn's / schedule's snapshot back in the panel (cancel, failure). */
      restoreSent(sessionId: string, key: string, reason: CommentRestoreReason): RestoreReviewResponse {
        const sent = sentTurns.get(`${sessionId}:${key}`);
        return sent ? restore(sent.scopeId, sent.scopeKind, sent.snapshots, reason) : { restored: 0, skipped: 0 };
      },
      nextId: () => `mock-comment-${++seq}`,
    },
  };
}
