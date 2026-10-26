import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Copy } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { CarryOver, Session } from "@/api/types";
import { resolveSupersededChain, listPredecessors } from "@/lib/sessionVisibility";
import { sessionLabel } from "@/lib/sessionLabel";
import { cliDisplayName } from "@/lib/cliNames";
import { copyText } from "@/lib/copyText";
import { useModesStore, ensureLoaded } from "@/store/modesStore";
import { useServerStore } from "@/hooks/useServerStore";
import { usePortalRoot } from "@/context/DemoEnv";

function formatArchivedTime(v: string): string {
  const d = /^\d+$/.test(v) ? new Date(Number(v)) : new Date(v);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** What a previous session handed to its successor (`undefined` = archived before it was recorded). */
export function carryLabel(carryOver: CarryOver | null | undefined): string {
  switch (carryOver) {
    case "summary":
      return "Summary carried over";
    case "transcript":
      return "Transcript linked";
    case "none":
      return "Nothing carried over";
    default:
      return "Carry-over not recorded";
  }
}

export interface PreviousSessionsListProps {
  api: ApiInstance;
  activeSession: Session | null;
  sessions: Session[];
  onOpen: (id: string) => void;
  /** Called after a row (or "Back to current") is picked, so a popover can close. */
  onNavigate?: () => void;
}

/**
 * The Previous sessions body, shared by the tab-strip popover
 * (`PreviousSessionsMenu`) and the pane-scoped dialog (`PaneDialogHost`).
 *
 * Each entry shows the predecessor's CLI chip, whether it was switched away
 * from or started fresh (compared against the successor's MODE, Decision 2),
 * its archived time, and an expandable summary with a Copy button. Opening it
 * refreshes the session list so fresh `handoffSummary`/`archivedAt` values are
 * rendered (the archive broadcast carries no summary).
 */
export function PreviousSessionsList({
  api,
  activeSession,
  sessions,
  onOpen,
  onNavigate,
}: PreviousSessionsListProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const portalRoot = usePortalRoot();
  const modes = useModesStore((s) => s.modes);

  const cliFor = useCallback(
    (modeId: string | null | undefined): string | undefined =>
      modeId ? modes.get(modeId)?.cli : undefined,
    [modes],
  );

  const modeNameFor = useCallback(
    (modeId: string | null | undefined): string | undefined =>
      modeId ? modes.get(modeId)?.name : undefined,
    [modes],
  );

  const headId = activeSession ? resolveSupersededChain(activeSession.id, sessions) : null;
  const preds = headId ? listPredecessors(headId, sessions) : [];

  /** Refresh sessions so the archive broadcast's missing summary arrives. */
  useEffect(() => {
    if (!headId) return;
    void ensureLoaded(api);
    const head = sessions.find((s) => s.id === headId);
    const scope = head?.worktreeId ?? undefined;
    void Promise.resolve()
      .then(() => api.listSessions(scope))
      .then((list) => {
        const store = useServerStore.getState();
        for (const s of list) store.applySessionUpdated(s.id, s);
      })
      .catch(() => {
        /* keep last-known on transient failure */
      });
    // Only refresh when the chain head changes — not on every session broadcast.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, headId]);

  if (!activeSession || preds.length === 0) return null;

  const isViewingPredecessor = preds.some((p) => p.id === activeSession.id);

  function toggleExpanded(id: string) {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function open(id: string) {
    onOpen(id);
    onNavigate?.();
  }

  return (
    <>
      {isViewingPredecessor ? (
        <button type="button" role="menuitem" className="menu-pop__item" onClick={() => open(headId as string)}>
          Back to current
        </button>
      ) : null}

      {preds.map((s) => {
        const isViewing = s.id === activeSession.id;
        const label = sessionLabel(s);
        const cli = cliFor(s.modeId);
        const successor = s.supersededBy ? sessions.find((x) => x.id === s.supersededBy) : undefined;
        const successorCli = successor ? cliFor(successor.modeId) : undefined;
        const successorMode = successor ? modeNameFor(successor.modeId) : undefined;
        const isSwitch = !!successor && successor.modeId !== s.modeId;
        const formattedTime = s.archivedAt ? formatArchivedTime(s.archivedAt) : "";
        const timeStr = formattedTime ? ` · ${formattedTime}` : "";
        const hasSummary = !!s.handoffSummary && s.handoffSummary.trim().length > 0;
        const isExpanded = expanded.has(s.id);

        return (
          <div key={s.id} className="prev-session">
            <div className="prev-session__top">
              {cli ? <span className="prev-session__chip">{cliDisplayName(cli)}</span> : null}
              <button type="button" className="prev-session__open" onClick={() => open(s.id)}>
                {label}
              </button>
              {isViewing ? <span className="prev-session__viewing">Viewing</span> : null}
              <span className="prev-session__when">
                {isSwitch
                  ? `Switched${successorMode ? ` to ${successorMode}` : successorCli ? ` to ${cliDisplayName(successorCli)}` : ""}`
                  : "Started fresh"}
                {timeStr}
              </span>
            </div>
            <div className="prev-session__carry" data-carry={s.carryOver ?? "unrecorded"}>
              {carryLabel(s.carryOver)}
            </div>
            {hasSummary ? (
              <div className="prev-session__summary-area">
                <div className="prev-session__summary-row">
                  <button
                    type="button"
                    className="prev-session__toggle"
                    aria-expanded={isExpanded}
                    onClick={() => toggleExpanded(s.id)}
                  >
                    {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    {isExpanded ? "Hide summary" : "Show summary"}
                  </button>
                  {isExpanded ? (
                    <button
                      type="button"
                      className="prev-session__copy"
                      onClick={() => void copyText(s.handoffSummary ?? "", portalRoot)}
                    >
                      <Copy size={12} />
                      Copy summary
                    </button>
                  ) : null}
                </div>
                {isExpanded ? <pre className="prev-session__summary">{s.handoffSummary}</pre> : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
