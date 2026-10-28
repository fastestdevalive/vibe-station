import { useEffect } from "react";
import type { ApiInstance } from "@/api";
import type { ArtifactScopeKind } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useCommentStore } from "./useCommentStore";

type ListApi = Pick<ApiInstance, "listComments">;

/** Latest request per scope wins. */
const requestSeq = new Map<string, number>();

/**
 * Fetch one scope into `useCommentStore`. A ready scope keeps its rows while it refetches; a failure clears
 * them (never a stale list under an error). An event that raced the fetch marked the scope stale, so the
 * subscriber below refetches once more.
 */
export async function fetchCommentScope(api: ListApi, scopeKind: ArtifactScopeKind, scopeId: string): Promise<void> {
  const seq = (requestSeq.get(scopeId) ?? 0) + 1;
  requestSeq.set(scopeId, seq);
  useCommentStore.getState().setLoading(scopeId, scopeKind);
  try {
    const res = await api.listComments(scopeId, scopeKind);
    if (requestSeq.get(scopeId) !== seq) return;
    useCommentStore.getState().replace(scopeId, scopeKind, res);
  } catch (e) {
    if (requestSeq.get(scopeId) !== seq) return;
    useCommentStore.getState().setError(scopeId, scopeKind, e instanceof Error ? e.message : "Couldn't load comments");
  }
}

/** Fetch on first need: a no-op unless the scope was never requested. */
export function ensureCommentScope(api: ListApi, scopeKind: ArtifactScopeKind, scopeId: string): void {
  const cur = useCommentStore.getState().byScope[scopeId];
  if (cur && cur.status !== "idle") return;
  void fetchCommentScope(api, scopeKind, scopeId);
}

/** Load a scope for the calling component's lifetime. */
export function useCommentScopeLoad(api: ListApi, scopeKind: ArtifactScopeKind, scopeId: string | null | undefined): void {
  useEffect(() => {
    if (scopeId && scopeId !== "__none__") ensureCommentScope(api, scopeKind, scopeId);
  }, [api, scopeKind, scopeId]);
}

/**
 * The single comments subscription (mounted once beside `useServerSync`, Decision 18): loads the active
 * context's scope, applies `comments:changed` / `terminal-delivery:updated`, marks every loaded scope stale on
 * `ws:open` / `ws:resync` (events may have been dropped) and refetches stale scopes, and drops scopes of
 * deleted worktrees / projects.
 */
export function useCommentsSync(api: ApiInstance): void {
  useEffect(() => {
    const store = () => useCommentStore.getState();

    const refetchStale = () => {
      for (const id of Object.keys(store().byScope)) {
        // Re-read per scope: starting a fetch re-enters this subscriber and clears the flag it consumed.
        const st = store().byScope[id];
        // A fetch already in flight is not restarted: its response is kept (`replace` leaves `stale` set when an event
        // raced it), so exactly one follow-up runs once it lands instead of every event discarding the response.
        if (st?.stale && st.status !== "loading" && !st.fetching) void fetchCommentScope(api, st.scopeKind, id);
      }
    };
    const offStore = useCommentStore.subscribe(refetchStale);

    // The active context (worktree, or the project of a direct session) is always loaded: the rail badge and
    // changed-file chips read it even while the tools pane is hidden.
    const loadActive = () => {
      const ws = useWorkspaceStore.getState();
      if (ws.activeWorktreeId) ensureCommentScope(api, "worktree", ws.activeWorktreeId);
      else if (ws.activeDirectContextId) ensureCommentScope(api, "project", ws.activeDirectContextId);
    };
    loadActive();
    const offWs = useWorkspaceStore.subscribe((s, prev) => {
      if (s.activeWorktreeId !== prev.activeWorktreeId || s.activeDirectContextId !== prev.activeDirectContextId) loadActive();
    });

    const offChanged = api.on("comments:changed", (ev) => {
      if (ev.type === "comments:changed") store().applyChanged(ev);
    });
    const offDelivery = api.on("terminal-delivery:updated", (ev) => {
      if (ev.type === "terminal-delivery:updated") store().applyDelivery(ev.delivery);
    });
    const offOpen = api.on("ws:open", () => store().markAllStale());
    const offResync = api.on("ws:resync", () => store().markAllStale());
    const offWt = api.on("worktree:deleted", (ev) => {
      if (ev.type === "worktree:deleted") store().dropScope(ev.worktreeId);
    });
    const offProj = api.on("project:deleted", (ev) => {
      if (ev.type === "project:deleted") store().dropScope(ev.projectId);
    });
    const offServer = useServerStore.subscribe((s, prev) => {
      if (s.worktrees === prev.worktrees) return;
      const alive = new Set(s.worktrees.map((w) => w.id));
      for (const w of prev.worktrees) if (!alive.has(w.id)) store().dropScope(w.id);
    });

    return () => {
      offStore();
      offWs();
      offChanged();
      offDelivery();
      offOpen();
      offResync();
      offWt();
      offProj();
      offServer();
    };
  }, [api]);
}
