import { useEffect, useRef } from "react";
import type { ApiInstance } from "@/api";
import type { Session } from "@/api/types";
import { useSessionReset } from "@/hooks/useSessionReset";
import { usePaneDialogs } from "@/hooks/usePaneDialogs";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { ResetModeDialog } from "@/components/dialogs/ResetModeDialog";
import { FreshDialog } from "@/components/dialogs/FreshDialog";
import { PreviousSessionsList } from "./PreviousSessionsList";
import "@/styles/fresh-dialog.css";

interface PaneDialogHostProps {
  api: ApiInstance;
  sessionId: string | null;
  session?: Session;
}

/**
 * Pane-scoped host for the Start fresh / Switch dialogs, the Previous sessions
 * dialog, the mode-retry prompt and the fallback notice (Decision 8).
 *
 * Mounted as the LAST sibling of `.agent-pane-slot` (where the deleted
 * `ResetProgressOverlay` used to be), so `TerminalPane`/`ChatPane` keep their
 * React tree position — opening a dialog never remounts the terminal. The
 * overlay is `position: absolute; inset: 0` inside the pane's own
 * `position: relative` box; siblings are made `inert` (mouse AND keyboard)
 * while it is open, via DOM attributes rather than restructuring the tree.
 */
export function PaneDialogHost({ api, sessionId, session }: PaneDialogHostProps) {
  const { run } = useSessionReset(api);
  const rootRef = useRef<HTMLDivElement>(null);

  const dialog = usePaneDialogs((s) => (sessionId ? s.dialogs[sessionId] : undefined));
  const busy = usePaneDialogs((s) => (sessionId ? s.busy[sessionId] : undefined));
  const prompt = usePaneDialogs((s) => (sessionId ? s.modePrompts[sessionId] : undefined));
  const notice = usePaneDialogs((s) => (sessionId ? s.notices[sessionId] : undefined));
  const sessions = useServerStore((s) => s.sessions);

  const open = !!sessionId && !!session && (dialog !== undefined || prompt !== undefined || notice !== undefined);

  useEffect(() => {
    const root = rootRef.current;
    if (!open || !root?.parentElement) return undefined;
    const inerted = Array.from(root.parentElement.children).filter(
      (el): el is HTMLElement => el !== root && el instanceof HTMLElement && !el.hasAttribute("inert"),
    );
    inerted.forEach((el) => el.setAttribute("inert", ""));
    return () => inerted.forEach((el) => el.removeAttribute("inert"));
  }, [open]);

  if (!open || !sessionId || !session) return null;

  // A notice raised by a Switch (the picked mode differs) must not offer "Nothing":
  // Switch always carries something (decision C), and its wording says "switch".
  const noticeIsSwitch = !!notice?.options.modeId && notice.options.modeId !== session.modeId;
  const noticeTitle = noticeIsSwitch ? "Couldn't switch" : "Couldn't start fresh";

  const closeAll = () => {
    const store = usePaneDialogs.getState();
    store.close(sessionId);
    store.clearModePrompt(sessionId);
    store.clearNotice(sessionId);
  };

  return (
    <div className="pane-dialog-host" ref={rootRef}>
      {dialog === "fresh" || dialog === "fresh-summary" || dialog === "switch" ? (
        <FreshDialog
          open
          kind={dialog === "switch" ? "switch" : "fresh"}
          defaultCarryOver={dialog === "fresh-summary" ? "summary" : undefined}
          api={api}
          session={session}
          busy={busy}
          onCancel={closeAll}
          onConfirm={(choice) =>
            run(sessionId, {
              carryOver: choice.carryOver,
              modeId: choice.modeId,
              channel: choice.channel,
              whenBusy: choice.whenBusy,
              queued: choice.queued,
            })
          }
        />
      ) : null}

      {dialog === "previous" ? (
        <div className="pane-dialog-card" role="dialog" aria-modal="true" aria-label="Previous sessions">
          <div className="pane-dialog-card__header">
            <h2>Previous sessions</h2>
            <button type="button" className="icon-btn" aria-label="Close dialog" onClick={closeAll}>
              ×
            </button>
          </div>
          <div className="pane-dialog-card__body">
            <p className="fresh-dialog__subtitle">Archived sessions that led to this one, newest first.</p>
            <PreviousSessionsList
              api={api}
              activeSession={session}
              sessions={sessions}
              onOpen={(id) => {
                useWorkspaceStore.getState().setActiveSession(id);
                closeAll();
              }}
            />
          </div>
        </div>
      ) : null}

      {/* The mode-retry prompt keeps its existing full-screen Dialog — it is the
          rare "the session's mode was deleted" recovery path, not a normal step. */}
      {prompt ? (
        <ResetModeDialog
          open
          api={api}
          reason={prompt.reason}
          onCancel={() => usePaneDialogs.getState().clearModePrompt(sessionId)}
          onConfirm={(modeId) => {
            usePaneDialogs.getState().clearModePrompt(sessionId);
            run(sessionId, { ...prompt.options, modeId });
          }}
        />
      ) : null}

      {/* Cancel / failed summary fallback (OQ2): the old agent stays live. */}
      {notice ? (
        <div className="pane-dialog-card" role="dialog" aria-modal="true" aria-label={noticeTitle}>
          <div className="pane-dialog-card__header">
            <h2>{noticeTitle}</h2>
            <button
              type="button"
              className="icon-btn"
              aria-label="Close dialog"
              onClick={() => usePaneDialogs.getState().clearNotice(sessionId)}
            >
              ×
            </button>
          </div>
          <div className="pane-dialog-card__body">
            <p className="fresh-dialog__subtitle">{notice.text}</p>
          </div>
          <div className="pane-dialog-card__footer">
            <button
              type="button"
              className="fresh-dialog__btn"
              onClick={() => run(sessionId, { ...notice.options, carryOver: "transcript" })}
            >
              {noticeIsSwitch ? "Switch with Transcript" : "Start fresh with Transcript"}
            </button>
            {noticeIsSwitch ? null : (
              <button
                type="button"
                className="fresh-dialog__btn"
                onClick={() => run(sessionId, { ...notice.options, carryOver: "none" })}
              >
                Start fresh with Nothing
              </button>
            )}
            <button
              type="button"
              className="fresh-dialog__btn"
              onClick={() => usePaneDialogs.getState().clearNotice(sessionId)}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
