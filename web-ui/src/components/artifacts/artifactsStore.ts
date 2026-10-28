import { create } from "zustand";
import type {
  ArtifactListResponse,
  ArtifactRemoveReason,
  ArtifactRow,
  ArtifactScopeKind,
  ArtifactUpsert,
} from "@/api/types";

export type ArtifactsStatus = "idle" | "loading" | "ready" | "error";

/** Two independent notice slots per scope (the list's bottom toasts): a cap burst and an "added" arrive together. */
export type CapNotice = { count: number; seq: number };
export type AddedNotice = { row: ArtifactRow; seq: number };
export type ArtifactNoticeKind = "cap" | "added";
export type ArtifactGroupKey = "run" | "earlier";

export interface ArtifactScopeState {
  scopeKind: ArtifactScopeKind;
  rows: ArtifactRow[];
  /** Last applied per-scope `rev`; events with `rev <= rev` are already reflected. */
  rev: number;
  /** Rows counting toward the cap, hidden included (the "n of 500" meta). */
  total: number;
  cap: number;
  status: ArtifactsStatus;
  error?: string;
  /** A `rev` gap, `ws:resync` or `ws:open` marked this scope for a refetch (consumed by `useArtifactsSync`). */
  stale: boolean;
  /** A GET is in flight (set by `setLoading`, cleared by `replace` / `setError`): `useArtifactsSync` does not start another meanwhile. */
  fetching: boolean;
  capNotice?: CapNotice;
  addedNotice?: AddedNotice;
}

interface ArtifactsStoreState {
  byScope: Record<string, ArtifactScopeState>;
  /** Group collapse overrides per scope; kept outside `byScope` so a refetch/error never wipes them. */
  groupOpen: Record<string, Partial<Record<ArtifactGroupKey, boolean>>>;
  setGroupOpen: (scopeId: string, group: ArtifactGroupKey, open: boolean) => void;
  /** Replace a scope with a fresh list response (a refetch always wins over events). */
  replace: (scopeId: string, scopeKind: ArtifactScopeKind, res: ArtifactListResponse) => void;
  setLoading: (scopeId: string, scopeKind: ArtifactScopeKind) => void;
  /** Never keeps stale rows: an error clears the list. */
  setError: (scopeId: string, scopeKind: ArtifactScopeKind, message: string) => void;
  /** Returns the rows new to the list (`created: true`) that were applied. */
  applyUpserted: (ev: { scopeId: string; rev: number; rows: ArtifactUpsert[] }) => ArtifactUpsert[];
  applyRemoved: (ev: { scopeId: string; rev: number; ids: string[]; reason: ArtifactRemoveReason }) => void;
  /** `ws:open` / `ws:resync`: every loaded scope refetches. */
  markAllStale: () => void;
  /** Replace a row with the server's copy after a pin/remove REST response (no optimistic write). */
  patchRow: (scopeId: string, row: ArtifactRow) => void;
  /** Drop one row locally after a successful Remove (the `artifact:removed` event that follows is idempotent). */
  hideRow: (scopeId: string, id: string) => void;
  dismissNotice: (scopeId: string, kind: ArtifactNoticeKind, seq?: number) => void;
  dropScope: (scopeId: string) => void;
  reset: () => void;
}

/** Newest first by `lastWrittenAt`, ties by id so the order is stable. */
export function sortRows(rows: ArtifactRow[]): ArtifactRow[] {
  return rows.slice().sort((a, b) => (a.lastWrittenAt === b.lastWrittenAt ? a.id.localeCompare(b.id) : a.lastWrittenAt < b.lastWrittenAt ? 1 : -1));
}

let noticeSeq = 0;

function emptyScope(scopeKind: ArtifactScopeKind): ArtifactScopeState {
  return { scopeKind, rows: [], rev: 0, total: 0, cap: ARTIFACT_CAP_DEFAULT, status: "idle", stale: false, fetching: false };
}

export const useArtifactsStore = create<ArtifactsStoreState>((set) => ({
  byScope: {},
  groupOpen: {},

  setGroupOpen: (scopeId, group, open) =>
    set((s) => ({ groupOpen: { ...s.groupOpen, [scopeId]: { ...s.groupOpen[scopeId], [group]: open } } })),

  replace: (scopeId, scopeKind, res) =>
    set((s) => {
      const cur = s.byScope[scopeId];
      // An event at a newer rev was applied while this (older) response was in flight: take the response but
      // refetch once, so the list is never rolled back past an applied event.
      const behind = cur?.status === "ready" && cur.rev > res.rev;
      return {
        byScope: {
          ...s.byScope,
          [scopeId]: {
            ...emptyScope(scopeKind),
            // Behind an applied event, or flagged (gap / ws:open) while this GET was in flight: refetch once more.
            stale: behind || (cur?.fetching === true && cur.stale),
            capNotice: cur?.capNotice,
            addedNotice: cur?.addedNotice,
            rows: sortRows(res.items),
            rev: res.rev,
            total: res.total,
            cap: res.cap,
            status: "ready",
          },
        },
      };
    }),

  setLoading: (scopeId, scopeKind) =>
    set((s) => {
      const cur = s.byScope[scopeId];
      // A refetch of a ready scope keeps its rows on screen (no skeleton flash); only a first load shows loading.
      if (cur && cur.status === "ready") return { byScope: { ...s.byScope, [scopeId]: { ...cur, stale: false, fetching: true } } };
      return { byScope: { ...s.byScope, [scopeId]: { ...(cur ?? emptyScope(scopeKind)), status: "loading", error: undefined, stale: false, fetching: true } } };
    }),

  setError: (scopeId, scopeKind, message) =>
    set((s) => ({
      byScope: {
        ...s.byScope,
        [scopeId]: { ...emptyScope(scopeKind), status: "error", error: message },
      },
    })),

  applyUpserted: (ev) => {
    let created: ArtifactUpsert[] = [];
    set((s) => {
      const cur = s.byScope[ev.scopeId];
      // Unknown or not-yet-loaded scope: nothing to patch (the first fetch reads the current state).
      if (!cur || cur.status !== "ready") return s;
      if (ev.rev <= cur.rev) return s;
      const gap = ev.rev > cur.rev + 1;
      const byId = new Map(cur.rows.map((r) => [r.id, r]));
      let total = cur.total;
      const fresh: ArtifactUpsert[] = [];
      for (const { created: isNew, ...row } of ev.rows) {
        if (!byId.has(row.id) && isNew) total += 1;
        byId.set(row.id, row);
        if (isNew) fresh.push({ ...row, created: true });
      }
      created = fresh;
      const latest = fresh.filter((r) => r.addedVia === "cli" && !r.inRepo).pop();
      return {
        byScope: {
          ...s.byScope,
          [ev.scopeId]: {
            ...cur,
            rows: sortRows([...byId.values()]),
            rev: ev.rev,
            total,
            stale: cur.stale || gap,
            addedNotice: latest ? { row: latest, seq: ++noticeSeq } : cur.addedNotice,
          },
        },
      };
    });
    return created;
  },

  applyRemoved: (ev) =>
    set((s) => {
      const cur = s.byScope[ev.scopeId];
      if (!cur || cur.status !== "ready") return s;
      if (ev.rev <= cur.rev) return s;
      const gap = ev.rev > cur.rev + 1;
      const drop = new Set(ev.ids);
      const rows = cur.rows.filter((r) => !drop.has(r.id));
      // A user "removed" row stays in the cap total (hidden rows count); cap/merged rows are gone for good.
      const total = ev.reason === "removed" ? cur.total : Math.max(0, cur.total - ev.ids.length);
      return {
        byScope: {
          ...s.byScope,
          [ev.scopeId]: {
            ...cur,
            rows,
            rev: ev.rev,
            total,
            stale: cur.stale || gap,
            capNotice:
              ev.reason === "cap" && ev.ids.length > 0
                ? { count: (cur.capNotice?.count ?? 0) + ev.ids.length, seq: ++noticeSeq }
                : cur.capNotice,
          },
        },
      };
    }),

  markAllStale: () =>
    set((s) => {
      const next: Record<string, ArtifactScopeState> = {};
      for (const [id, st] of Object.entries(s.byScope)) next[id] = st.status === "idle" ? st : { ...st, stale: true };
      return { byScope: next };
    }),

  patchRow: (scopeId, row) =>
    set((s) => {
      const cur = s.byScope[scopeId];
      if (!cur) return s;
      if (!cur.rows.some((r) => r.id === row.id)) return s;
      return { byScope: { ...s.byScope, [scopeId]: { ...cur, rows: sortRows(cur.rows.map((r) => (r.id === row.id ? row : r))) } } };
    }),

  hideRow: (scopeId, id) =>
    set((s) => {
      const cur = s.byScope[scopeId];
      if (!cur || !cur.rows.some((r) => r.id === id)) return s;
      return { byScope: { ...s.byScope, [scopeId]: { ...cur, rows: cur.rows.filter((r) => r.id !== id) } } };
    }),

  dismissNotice: (scopeId, kind, seq) =>
    set((s) => {
      const cur = s.byScope[scopeId];
      const slot = kind === "cap" ? cur?.capNotice : cur?.addedNotice;
      if (!cur || !slot || (seq != null && slot.seq !== seq)) return s;
      const next = kind === "cap" ? { ...cur, capNotice: undefined } : { ...cur, addedNotice: undefined };
      return { byScope: { ...s.byScope, [scopeId]: next } };
    }),

  dropScope: (scopeId) =>
    set((s) => {
      if (!(scopeId in s.byScope) && !(scopeId in s.groupOpen)) return s;
      const next = { ...s.byScope };
      delete next[scopeId];
      const groupOpen = { ...s.groupOpen };
      delete groupOpen[scopeId];
      return { byScope: next, groupOpen };
    }),

  reset: () => set({ byScope: {}, groupOpen: {} }),
}));

/** Stable empty list so selectors do not re-render on a missing scope. */
export const NO_ROWS: ArtifactRow[] = [];

export function rowsFor(state: ArtifactsStoreState, scopeId: string): ArtifactRow[] {
  return state.byScope[scopeId]?.rows ?? NO_ROWS;
}

/**
 * The ONE "which row is this tab" rule: the canonical absolute path, or (in-repo rows) the repo-relative display
 * path. List selection, the strip pin and the preview source all use it.
 */
export function rowMatchesPath(row: ArtifactRow, path: string | null | undefined): boolean {
  return path != null && (row.path === path || (row.inRepo && row.displayPath === path));
}

/** Rows kept per scope by the daemon (mirrors vst-artifacts); the list shows "N of cap". */
export const ARTIFACT_CAP_DEFAULT = 500;
/** Pinned rows allowed per scope (mirrors vst-artifacts; `PIN_LIMIT`). */
export const PIN_LIMIT = 50;

