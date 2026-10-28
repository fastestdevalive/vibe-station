import { create } from "zustand";
import type {
  ArtifactScopeKind,
  CommentListResponse,
  DeletedReason,
  ReviewComment,
  TerminalDelivery,
} from "@/api/types";

export type CommentsStatus = "idle" | "loading" | "ready" | "error";

/** A comment another device removed (deleted / sent / scheduled): kept so an open box can explain itself. */
export interface RemovedEntry {
  comment: ReviewComment;
  reason: DeletedReason;
}

export interface CommentScopeState {
  scopeKind: ArtifactScopeKind;
  status: CommentsStatus;
  error?: string;
  /** Sorted by pin. */
  comments: ReviewComment[];
  nextPin: number;
  /** In-flight and just-finished immediate Terminal deliveries by id. */
  deliveries: Record<string, TerminalDelivery>;
  /** Comments removed by someone else, by id (cleared when the box closes or the comment comes back). */
  removed: Record<string, RemovedEntry>;
  /** `ws:open` / `ws:resync` (or an event that raced a fetch) marked this scope for a refetch. */
  stale: boolean;
  /** A GET is in flight (set by `setLoading`, cleared by `replace` / `setError`): events landing now may predate its response. */
  fetching: boolean;
  /** Ids this client removed itself (its own delete / send): their echo event leaves no notice. */
  localRemoved: string[];
  /** Ids removed by this client while a GET was in flight: that response may still list them (dropped on landing). */
  removedWhileFetching: string[];
}

interface CommentStoreState {
  byScope: Record<string, CommentScopeState>;
  setLoading: (scopeId: string, kind: ArtifactScopeKind) => void;
  replace: (scopeId: string, kind: ArtifactScopeKind, res: CommentListResponse) => void;
  setError: (scopeId: string, kind: ArtifactScopeKind, message: string) => void;
  /** `comments:changed`. An event that lands while the scope is loading marks it stale (the response may be older). */
  applyChanged: (ev: {
    scopeId: string;
    scopeKind: ArtifactScopeKind;
    upserted: ReviewComment[];
    deleted: Array<{ id: string; reason: DeletedReason }>;
  }) => void;
  applyDelivery: (delivery: TerminalDelivery) => void;
  /** The requester's own HTTP response (create / patch): idempotent with the event that follows. */
  upsertLocal: (comment: ReviewComment) => void;
  /** The requester removed these itself (delete, send): no notice, even when the echo event arrives. */
  removeLocal: (scopeId: string, ids: string[]) => void;
  clearRemoved: (scopeId: string, id: string) => void;
  /** The requester's attach / detach response: set `attachedTo` on these ids (idempotent with the event that follows). */
  setAttachedLocal: (scopeId: string, ids: string[], attachedTo: string | undefined) => void;
  /** Forget a finished delivery (its tray notice was dismissed or acted on). */
  dropDelivery: (scopeId: string, deliveryId: string) => void;
  markAllStale: () => void;
  dropScope: (scopeId: string) => void;
  reset: () => void;
}

const sortByPin = (rows: ReviewComment[]) => rows.slice().sort((a, b) => a.pin - b.pin);

function empty(kind: ArtifactScopeKind): CommentScopeState {
  return { scopeKind: kind, status: "idle", comments: [], nextPin: 1, deliveries: {}, removed: {}, stale: false, fetching: false, localRemoved: [], removedWhileFetching: [] };
}

/** Deliveries that already finished stay in the scope until a newer one replaces them; the list keeps the last few. */
const MAX_FINISHED_DELIVERIES = 5;

function pruneDeliveries(map: Record<string, TerminalDelivery>): Record<string, TerminalDelivery> {
  const live = (d: TerminalDelivery) => d.state === "waiting" || d.state === "pasting";
  const finished = Object.values(map)
    .filter((d) => !live(d))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, MAX_FINISHED_DELIVERIES);
  const keep = new Set([...Object.values(map).filter(live), ...finished].map((d) => d.id));
  return Object.fromEntries(Object.entries(map).filter(([id]) => keep.has(id)));
}

/**
 * The single client source for review comments (Decision 18): seeded by `GET .../comments` (mount, `ws:open`,
 * `ws:resync`, see `useCommentsSync`) and mutated only by `comments:changed`, `terminal-delivery:updated` and
 * the requester's own HTTP responses. Drafts alone live in `localStorage` (`commentDrafts.ts`).
 */
export const useCommentStore = create<CommentStoreState>((set) => ({
  byScope: {},

  setLoading: (scopeId, kind) =>
    set((s) => {
      const cur = s.byScope[scopeId];
      // A refetch of a ready scope keeps its rows on screen (no skeleton flash).
      if (cur?.status === "ready") return { byScope: { ...s.byScope, [scopeId]: { ...cur, stale: false, fetching: true, removedWhileFetching: [] } } };
      return {
        byScope: {
          ...s.byScope,
          [scopeId]: { ...(cur ?? empty(kind)), status: "loading", error: undefined, stale: false, fetching: true, removedWhileFetching: [] },
        },
      };
    }),

  replace: (scopeId, kind, res) =>
    set((s) => {
      const cur = s.byScope[scopeId] ?? empty(kind);
      const deliveries: Record<string, TerminalDelivery> = {};
      for (const d of res.terminalDeliveries) deliveries[d.id] = d;
      // Keep finished deliveries the server no longer lists (the tray outcome stays until dismissed).
      for (const d of Object.values(cur.deliveries)) {
        if (!deliveries[d.id] && d.state !== "waiting" && d.state !== "pasting") deliveries[d.id] = d;
      }
      const ids = new Set(res.comments.map((c) => c.id));
      const removed: Record<string, RemovedEntry> = Object.fromEntries(
        Object.entries(cur.removed).filter(([id]) => !ids.has(id)),
      );
      // A row the fresh list dropped that this client did not remove itself went away while we were not listening
      // (a missed `comments:changed`, e.g. across a reconnect): leave the same notice the event path would, so an
      // open Edit box explains itself instead of silently closing. The reason is unknown; "deleted" offers Restore.
      for (const prev of cur.comments) {
        if (!ids.has(prev.id) && !cur.localRemoved.includes(prev.id) && !removed[prev.id]) {
          removed[prev.id] = { comment: prev, reason: "deleted" };
        }
      }
      return {
        byScope: {
          ...s.byScope,
          [scopeId]: {
            ...cur,
            scopeKind: kind,
            status: "ready",
            error: undefined,
            // An event that landed mid-fetch may postdate this response: keep the flag so one more refetch runs.
            stale: cur.fetching ? cur.stale : false,
            fetching: false,
            // Rows this client deleted while the GET was in flight must not flash back (the follow-up refetch,
            // forced by `stale`, then confirms the delete).
            comments: sortByPin(res.comments.filter((c) => !cur.removedWhileFetching.includes(c.id))),
            nextPin: res.nextPin,
            deliveries: pruneDeliveries(deliveries),
            removed,
            localRemoved: cur.fetching && cur.stale ? cur.localRemoved : [],
            removedWhileFetching: [],
          },
        },
      };
    }),

  setError: (scopeId, kind, message) =>
    set((s) => ({
      byScope: { ...s.byScope, [scopeId]: { ...empty(kind), status: "error", error: message } },
    })),

  applyChanged: (ev) =>
    set((s) => {
      const cur = s.byScope[ev.scopeId];
      // Never requested: the first fetch reads the current state.
      if (!cur || cur.status === "idle") return s;
      // Mid-fetch (or never loaded): the response may predate this event, so refetch afterwards.
      if (cur.status !== "ready") return { byScope: { ...s.byScope, [ev.scopeId]: { ...cur, stale: true } } };
      // A ready scope that is refetching: apply the event AND mark stale, so the (possibly older) response is
      // discarded by the next fetch instead of rolling this event back.
      const midFetch = cur.fetching;
      const byId = new Map(cur.comments.map((c) => [c.id, c]));
      const removed = { ...cur.removed };
      let localRemoved = cur.localRemoved;
      for (const c of ev.upserted) {
        byId.set(c.id, c);
        delete removed[c.id];
      }
      for (const d of ev.deleted) {
        const prev = byId.get(d.id);
        byId.delete(d.id);
        if (localRemoved.includes(d.id)) {
          localRemoved = localRemoved.filter((x) => x !== d.id);
        } else if (prev) {
          removed[d.id] = { comment: prev, reason: d.reason };
        }
      }
      const comments = sortByPin([...byId.values()]);
      const nextPin = Math.max(1, ...comments.map((c) => c.pin + 1));
      return { byScope: { ...s.byScope, [ev.scopeId]: { ...cur, comments, nextPin, removed, localRemoved, stale: cur.stale || midFetch } } };
    }),

  applyDelivery: (delivery) =>
    set((s) => {
      const cur = s.byScope[delivery.scopeId];
      if (!cur || cur.status === "idle") return s;
      const deliveries = pruneDeliveries({ ...cur.deliveries, [delivery.id]: delivery });
      // A terminal outcome (comments restored, rows deleted) is announced by `comments:changed`; a refetch covers a lost one.
      return { byScope: { ...s.byScope, [delivery.scopeId]: { ...cur, deliveries } } };
    }),

  upsertLocal: (comment) =>
    set((s) => {
      const cur = s.byScope[comment.scopeId];
      if (!cur || cur.status !== "ready") return s;
      const comments = sortByPin([...cur.comments.filter((c) => c.id !== comment.id), comment]);
      const removed = { ...cur.removed };
      delete removed[comment.id];
      return {
        byScope: {
          ...s.byScope,
          [comment.scopeId]: { ...cur, comments, removed, nextPin: Math.max(1, ...comments.map((c) => c.pin + 1)) },
        },
      };
    }),

  removeLocal: (scopeId, ids) =>
    set((s) => {
      const cur = s.byScope[scopeId];
      if (!cur) return s;
      const gone = new Set(ids);
      return {
        byScope: {
          ...s.byScope,
          [scopeId]: {
            ...cur,
            comments: cur.comments.filter((c) => !gone.has(c.id)),
            // A GET already in flight may still list these rows: refetch once it lands.
            stale: cur.stale || cur.fetching,
            removedWhileFetching: cur.fetching ? [...cur.removedWhileFetching, ...ids] : cur.removedWhileFetching,
            localRemoved: [...cur.localRemoved, ...ids.filter((id) => cur.comments.some((c) => c.id === id))],
          },
        },
      };
    }),

  clearRemoved: (scopeId, id) =>
    set((s) => {
      const cur = s.byScope[scopeId];
      if (!cur?.removed[id]) return s;
      const removed = { ...cur.removed };
      delete removed[id];
      return { byScope: { ...s.byScope, [scopeId]: { ...cur, removed } } };
    }),

  setAttachedLocal: (scopeId, ids, attachedTo) =>
    set((s) => {
      const cur = s.byScope[scopeId];
      if (!cur) return s;
      const hit = new Set(ids);
      const comments = cur.comments.map((c) => {
        if (!hit.has(c.id)) return c;
        const next = { ...c };
        if (attachedTo) next.attachedTo = attachedTo;
        else delete next.attachedTo;
        return next;
      });
      return { byScope: { ...s.byScope, [scopeId]: { ...cur, comments } } };
    }),

  dropDelivery: (scopeId, deliveryId) =>
    set((s) => {
      const cur = s.byScope[scopeId];
      if (!cur?.deliveries[deliveryId]) return s;
      const deliveries = { ...cur.deliveries };
      delete deliveries[deliveryId];
      return { byScope: { ...s.byScope, [scopeId]: { ...cur, deliveries } } };
    }),

  markAllStale: () =>
    set((s) => ({
      byScope: Object.fromEntries(
        Object.entries(s.byScope).map(([id, st]) => [id, st.status === "idle" ? st : { ...st, stale: true }]),
      ),
    })),

  dropScope: (scopeId) =>
    set((s) => {
      if (!s.byScope[scopeId]) return s;
      const byScope = { ...s.byScope };
      delete byScope[scopeId];
      return { byScope };
    }),

  reset: () => set({ byScope: {} }),
}));
