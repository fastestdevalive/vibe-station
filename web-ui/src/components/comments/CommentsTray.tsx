import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { ArtifactScopeKind, ReviewComment } from "@/api/types";
import { Banner } from "@/components/ui/Banner";
import { useServerStore } from "@/hooks/useServerStore";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useVirtualKeyboardVisible } from "@/hooks/useVirtualKeyboardVisible";
import { registerEscapeLayer } from "@/lib/escapeLayers";
import { sessionLabel } from "@/lib/sessionLabel";
import { sortForList } from "./commentSelectors";
import { jumpToComment } from "./commentJump";
import { CommentsList } from "./CommentsList";
import {
  copyReviewAsText,
  detachFromComposer,
  retryDelivery,
  reviewErrorText,
  type ReviewScope,
} from "./reviewActions";
import { ReviewPicker } from "./ReviewPicker";
import { TrayResizeHandle } from "./TrayResizeHandle";
import { useTrayHeight } from "./useTrayHeight";
import { TrayStrip } from "./TrayStrip";
import { deriveTrayState, RESTORED_COPY } from "./trayState";
import { useApiOnline } from "./useApiOnline";
import { fetchCommentScope, useCommentScopeLoad } from "./useCommentsSync";
import { useCommentScope } from "./commentSelectors";
import { useCommentStore } from "./useCommentStore";

interface CommentsTrayProps {
  api: ApiInstance;
  scopeId: string;
  scopeKind: ArtifactScopeKind;
}

type PickerState = null | { initialWhen: "now" | "later" };

/**
 * The comments tray (R56-R60, R134): a footer strip at the bottom of the tools pane that expands upward into
 * the list ("Needs you" / "Attached"). Hidden when there are no comments. It reads only `useCommentStore`
 * (comments, attach state, Terminal deliveries: one source), derives its state with `deriveTrayState`, and owns
 * the ticked selection, the picker and the Terminal send actions (Cancel · restore, Retry, Pick another).
 * Mounted as a sibling after `.tool-panel__body`, so it never changes the agent panel's tree path.
 */
export function CommentsTray({ api, scopeId, scopeKind }: CommentsTrayProps) {
  useCommentScopeLoad(api, scopeKind, scopeId);
  const scope = useCommentScope(scopeId);
  const online = useApiOnline(api);
  const keyboard = useVirtualKeyboardVisible();
  const compact = useIsMobile();
  const sessions = useServerStore((s) => s.sessions);
  const [expanded, setExpanded] = useState(false);
  const [picker, setPicker] = useState<PickerState>(null);
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const sendRef = useRef<HTMLDivElement>(null);
  const trayRef = useRef<HTMLElement>(null);
  const trayHeight = useTrayHeight(trayRef, expanded);
  const listId = useId();
  const reviewScope: ReviewScope = useMemo(() => ({ scopeKind, scopeId }), [scopeKind, scopeId]);

  const tray = useMemo(() => deriveTrayState({ scope, online }), [scope, online]);
  const comments = scope?.comments;
  const unsent = useMemo(() => sortForList((comments ?? []).filter((c) => !c.attachedTo)), [comments]);
  const checked: ReviewComment[] = useMemo(() => unsent.filter((c) => !unchecked.has(c.id)), [unsent, unchecked]);

  // Forget unticked ids that left the panel (sent, deleted) so a new comment is ticked by default.
  useEffect(() => {
    setUnchecked((cur) => {
      const live = new Set(unsent.map((c) => c.id));
      const next = new Set([...cur].filter((id) => live.has(id)));
      return next.size === cur.size ? cur : next;
    });
  }, [unsent]);

  // The expanded list is a layer on the escape stack (below the picker and the comment box).
  useEffect(() => {
    if (!expanded) return undefined;
    return registerEscapeLayer("tray", () => {
      setExpanded(false);
      return true;
    }, () => trayRef.current?.closest(".tool-panel") ?? null);
  }, [expanded]);

  // The list has nothing left to show once the panel empties.
  useEffect(() => {
    if (tray.count === 0) setExpanded(false);
  }, [tray.count]);

  const sessionName = useCallback(
    (id: string) => {
      const s = sessions.find((x) => x.id === id);
      return s ? sessionLabel(s) : "the agent";
    },
    [sessions],
  );
  const composerName = useCallback((key: string) => sessionName(key.replace(/^session:/, "")), [sessionName]);
  const composerNames = useCallback((keys: string[]) => keys.map(composerName).join(", "), [composerName]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(reviewErrorText(e, api, reviewScope));
      } finally {
        setBusy(false);
      }
    },
    [api, reviewScope],
  );

  const copy = () =>
    void act(async () => {
      const ids = checked.length > 0 ? checked.map((c) => c.id) : (comments ?? []).map((c) => c.id);
      const ok = await copyReviewAsText(api, reviewScope, ids);
      setCopied(ok);
      if (ok) window.setTimeout(() => setCopied(false), 1500);
      else throw new Error("Couldn't copy to the clipboard.");
    });

  const p = tray.primary;
  const announce =
    p.kind === "sending"
      ? `Sending ${p.delivery.commentCount} to ${sessionName(p.delivery.sessionId)}, ${p.phase === "waiting" ? "waiting until ready" : "pasting"}`
      : p.kind === "timed_out"
        ? `Timed out, ${sessionName(p.delivery.sessionId)} still busy, comments restored`
        : p.kind === "agent_exited"
          ? "Agent exited, not delivered, comments restored"
          : p.kind === "restored"
            ? `${p.count} ${p.count === 1 ? "comment" : "comments"} restored, ${[...new Set(p.groups.map((g) => RESTORED_COPY[g.reason]))].join(", ")}`
            : "";

  // A touch keyboard is open: the tray steps aside so it never sits over the chat box. An open send picker stays
  // MOUNTED (the tray is only hidden below), or typing its message would unmount the sheet and lose its state.
  if (keyboard && !picker) return null;

  if (scope?.status === "error" && tray.count === 0) {
    return (
      <section className="comment-tray" aria-label="Review comments">
        <Banner
          tone="error"
          actions={
            <button type="button" className="comment-btn" onClick={() => void fetchCommentScope(api, scopeKind, scopeId)}>
              Retry
            </button>
          }
        >
          Couldn’t load comments.
        </Banner>
      </section>
    );
  }
  if (p.kind === "hidden") return null;

  const store = useCommentStore.getState();
  const strip = (
    <TrayStrip
      ref={sendRef}
      tray={tray}
      expanded={expanded}
      compact={compact}
      selectedCount={checked.length}
      agentName={sessionName}
      composerNames={composerNames}
      busy={busy}
      error={error}
      listId={listId}
      copied={copied}
      onToggleExpanded={() => setExpanded((v) => !v)}
      onSend={() => setPicker({ initialWhen: "now" })}
      onSchedule={() => setPicker({ initialWhen: "later" })}
      onCopy={copy}
      onDetach={() =>
        void act(() =>
          detachFromComposer(api, reviewScope, {
            commentIds: (comments ?? []).filter((c) => c.attachedTo).map((c) => c.id),
          }),
        )
      }
      onCancelDelivery={(id) =>
        void act(async () => {
          await api.cancelTerminalDelivery(id);
          store.dropDelivery(scopeId, id);
        })
      }
      onRetry={() => {
        if (p.kind === "timed_out") void act(() => retryDelivery(api, reviewScope, p.delivery));
      }}
      onDismissDelivery={() => {
        if (p.kind === "timed_out" || p.kind === "agent_exited") store.dropDelivery(scopeId, p.delivery.id);
      }}
      onPickAnother={() => {
        if (p.kind === "agent_exited") store.dropDelivery(scopeId, p.delivery.id);
        setPicker({ initialWhen: "now" });
      }}
      onDismissRestored={() => void act(() => api.dismissRestoredComments(scopeId, scopeKind))}
    />
  );

  return (
    <section
      ref={trayRef}
      className={`comment-tray${expanded ? " comment-tray--expanded" : ""}`}
      aria-label="Review comments"
      style={keyboard ? { display: "none" } : undefined}
    >
      <span className="comment-sr" aria-live="polite" role="status">
        {announce}
      </span>
      {expanded ? <TrayResizeHandle height={trayHeight} /> : null}
      {expanded ? (
        <div id={listId} className="comment-tray__list" style={{ height: trayHeight.shown }}>
          <CommentsList
            comments={comments ?? []}
            status={scope?.status ?? "idle"}
            unchecked={unchecked}
            onToggle={(id) =>
              setUnchecked((cur) => {
                const next = new Set(cur);
                if (!next.delete(id)) next.add(id);
                return next;
              })
            }
            onToggleAll={(ids, on) => setUnchecked(on ? new Set() : new Set(ids))}
            onOpen={(c) => {
              jumpToComment(c);
              // On a phone the list covers the pane: collapse it so the opened file is visible.
              if (compact) setExpanded(false);
            }}
            onDetach={(c) => void act(() => detachFromComposer(api, reviewScope, { commentIds: [c.id] }))}
            onRetryLoad={() => void fetchCommentScope(api, scopeKind, scopeId)}
            composerName={composerName}
          />
        </div>
      ) : null}
      {strip}
      {picker && checked.length > 0 ? (
        <ReviewPicker
          api={api}
          scope={reviewScope}
          comments={checked}
          initialWhen={picker.initialWhen}
          anchorRef={sendRef}
          onClose={() => setPicker(null)}
          onDone={() => setUnchecked(new Set())}
        />
      ) : null}
    </section>
  );
}
