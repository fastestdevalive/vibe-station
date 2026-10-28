import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Session, TerminalReadiness } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { isSessionModeMissing } from "@/lib/modeIcon";
import { ensureLoaded, retainSubscription, useModesStore } from "@/store/modesStore";
import { buildPickerRow, wantsReadiness, type PickerRowModel } from "./pickerEligibility";
import type { ReviewScope } from "./reviewActions";

/** Agents of a comment scope: a worktree's sessions, or a project's direct sessions. Live agents only. */
export function sessionsInScope(sessions: readonly Session[], scope: ReviewScope): Session[] {
  return sessions
    .filter((s) => {
      if (s.type !== "agent" || s.archivedAt) return false;
      return scope.scopeKind === "worktree" ? s.worktreeId === scope.scopeId : !s.worktreeId && s.projectId === scope.scopeId;
    })
    .sort((a, b) => Number(b.isMain) - Number(a.isMain) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.createdAt.localeCompare(b.createdAt));
}

/**
 * The picker's rows: every agent of the scope with its LIVE state (`sessionStates[id] ?? session.state`, never
 * `.lifecycleState`), CLI capability and, when `active`, a one-shot readiness read per Terminal row (a bounded
 * pane probe; failure or `unknown` leaves the plain state text). The delivery-time probe is the real gate.
 */
export function usePickerRows(api: ApiInstance, scope: ReviewScope, active: boolean): PickerRowModel[] {
  const sessions = useServerStore((s) => s.sessions);
  const states = useWorkspaceStore((s) => s.sessionStates);
  const modes = useModesStore((s) => s.modes);
  const modesLoaded = useModesStore((s) => s.loaded);
  const [caps, setCaps] = useState<Map<string, boolean> | null>(null);
  const [readiness, setReadiness] = useState<Record<string, TerminalReadiness>>({});
  const probed = useRef(new Set<string>());
  // Probes that answered (or failed): until then a Terminal row is `pending` for the default selection.
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    void ensureLoaded(api);
    return retainSubscription(api);
  }, [api, active]);

  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    api
      .getSupportedClis()
      .then((list) => {
        if (live) setCaps(new Map(list.map((c) => [c.id, c.supportsTerminalComments === true])));
      })
      .catch(() => {
        // Capability unknown: Terminal rows stay "checking support…" (disabled) rather than offering a doomed send.
      });
    return () => {
      live = false;
    };
  }, [api, active]);

  const scoped = useMemo(() => sessionsInScope(sessions, scope), [sessions, scope]);

  const rows = useMemo(
    () =>
      scoped.map((session) => {
        const state = states[session.id] ?? session.state;
        const mode = session.modeId ? modes.get(session.modeId) : undefined;
        return buildPickerRow({
          session,
          state,
          supportsTerminalComments: mode && caps ? (caps.get(mode.cli) ?? false) : undefined,
          modeMissing: modesLoaded && isSessionModeMissing(session, modes),
          readiness: readiness[session.id],
          readinessPending: !settled.has(session.id),
        });
      }),
    [scoped, states, modes, modesLoaded, caps, readiness, settled],
  );

  // Read readiness once per open for the Terminal rows that can still send.
  const probeKey = rows.filter(wantsReadiness).map((r) => r.id).join(",");
  useEffect(() => {
    if (!active) {
      probed.current.clear();
      return undefined;
    }
    if (!probeKey) return undefined;
    for (const id of probeKey.split(",")) {
      if (probed.current.has(id)) continue;
      probed.current.add(id);
      api
        .terminalReadiness(id)
        .then((r) => {
          if (mounted.current) setReadiness((cur) => (cur[id] === r ? cur : { ...cur, [id]: r }));
        })
        .catch(() => {
          // Unknown: plain state text, the delivery-time probe decides.
        })
        .finally(() => {
          if (mounted.current) setSettled((cur) => (cur.has(id) ? cur : new Set(cur).add(id)));
        });
    }
    return undefined;
  }, [api, active, probeKey]);

  return rows;
}
