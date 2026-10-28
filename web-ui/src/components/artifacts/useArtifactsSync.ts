import { useEffect } from "react";
import type { ApiInstance } from "@/api";
import type { ArtifactScopeKind } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { useArtifactsStore } from "./artifactsStore";

type ListApi = Pick<ApiInstance, "listArtifacts">;

/** Latest request per scope wins: a refetch started during another one supersedes it. */
const requestSeq = new Map<string, number>();

/**
 * Fetch one scope's list into `artifactsStore`. A scope that is already `ready` keeps its rows while it
 * refetches (no skeleton flash); a failure clears them (never a stale list under an error).
 */
export async function fetchArtifactScope(api: ListApi, scopeKind: ArtifactScopeKind, scopeId: string): Promise<void> {
  const seq = (requestSeq.get(scopeId) ?? 0) + 1;
  requestSeq.set(scopeId, seq);
  const store = useArtifactsStore.getState();
  store.setLoading(scopeId, scopeKind);
  try {
    const res = await api.listArtifacts(scopeId, scopeKind);
    if (requestSeq.get(scopeId) !== seq) return;
    useArtifactsStore.getState().replace(scopeId, scopeKind, res);
  } catch (e) {
    if (requestSeq.get(scopeId) !== seq) return;
    useArtifactsStore.getState().setError(scopeId, scopeKind, e instanceof Error ? e.message : "Couldn't load artifacts");
  }
}

/** Fetch on first need (list mode or a path tab): no-op unless the scope has never been requested. */
export function ensureArtifactScope(api: ListApi, scopeKind: ArtifactScopeKind, scopeId: string): void {
  const cur = useArtifactsStore.getState().byScope[scopeId];
  if (cur && cur.status !== "idle") return;
  void fetchArtifactScope(api, scopeKind, scopeId);
}

/** Fetch on first need for the lifetime of the calling component. */
export function useArtifactScope(api: ListApi, scopeKind: ArtifactScopeKind, scopeId: string | null | undefined): void {
  useEffect(() => {
    if (scopeId) ensureArtifactScope(api, scopeKind, scopeId);
  }, [api, scopeKind, scopeId]);
}

/**
 * The single artifacts subscription (mounted once beside `useServerSync`): applies `artifact:*` events,
 * marks every loaded scope stale on `ws:open` / `ws:resync`, refetches stale scopes, and drops scopes of
 * deleted worktrees/projects.
 */
export function useArtifactsSync(api: ApiInstance): void {
  useEffect(() => {
    const store = () => useArtifactsStore.getState();

    const refetchStale = () => {
      for (const id of Object.keys(store().byScope)) {
        // Re-read per scope: starting a fetch re-enters this subscriber and clears the flags it consumed.
        const st = store().byScope[id];
        // Not while a GET is in flight: its response is kept and `replace` leaves one follow-up if the scope went stale meanwhile.
        if (st?.stale && !st.fetching) void fetchArtifactScope(api, st.scopeKind, id);
      }
    };

    const offStore = useArtifactsStore.subscribe(refetchStale);

    const offUpserted = api.on("artifact:upserted", (ev) => {
      if (ev.type === "artifact:upserted") store().applyUpserted(ev);
    });
    const offRemoved = api.on("artifact:removed", (ev) => {
      if (ev.type === "artifact:removed") store().applyRemoved(ev);
    });
    const offOpen = api.on("ws:open", () => store().markAllStale());
    const offResync = api.on("ws:resync", () => store().markAllStale());
    const offWt = api.on("worktree:deleted", (ev) => {
      if (ev.type === "worktree:deleted") store().dropScope(ev.worktreeId);
    });
    const offProj = api.on("project:deleted", (ev) => {
      if (ev.type === "project:deleted") store().dropScope(ev.projectId);
    });

    // A deleted project takes its worktrees with it (the server store cascades them): drop the scopes of
    // worktrees that LEFT the store (a diff, so a worktree not yet announced is never dropped by mistake).
    const offServer = useServerStore.subscribe((s, prev) => {
      if (s.worktrees === prev.worktrees) return;
      const alive = new Set(s.worktrees.map((w) => w.id));
      for (const w of prev.worktrees) if (!alive.has(w.id)) store().dropScope(w.id);
    });

    return () => {
      offStore();
      offUpserted();
      offRemoved();
      offOpen();
      offResync();
      offWt();
      offProj();
      offServer();
    };
  }, [api]);
}
