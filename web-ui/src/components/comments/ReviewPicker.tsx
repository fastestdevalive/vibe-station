import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Copy, Plus } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { ReviewComment } from "@/api/types";
import { SkillEditor, type SkillEditorHandle } from "@/components/chat/SkillEditor";
import type { MentionEditorConfig } from "@/components/mentions/types";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { usePortalRoot } from "@/context/DemoEnv";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useSkillCommands } from "@/hooks/useSkillCommands";
import { registerEscapeLayer } from "@/lib/escapeLayers";
import { renderDraftText } from "@/lib/mentions";
import { clampPopupPosition } from "@/lib/popupPosition";
import { checkFireAt, defaultFireAt } from "@/components/chat/ScheduleSendPopover";
import { clearDraft, loadDraft, pickerDraftKey, saveDraft } from "./commentDrafts";
import {
  attachFromPicker,
  copyReviewAsText,
  newAgentWithComments,
  reviewErrorText,
  scheduleReview,
  sendToRichChat,
  sendToTerminal,
  type ReviewScope,
} from "./reviewActions";
import { TERMINAL_SEND_MAX_BYTES, blockBytes, checkSendLimit, utf8Bytes } from "./reviewLimits";
import { enabledRowIds, resolveDefaultRow, stepRow } from "./pickerDefault";
import { ReviewPickerRow } from "./ReviewPickerRow";
import { ReviewPickerWhen, type PickerWhen } from "./ReviewPickerWhen";
import { COPY_OFFLINE_TITLE, SEND_LIMIT_HINT, TERMINAL_SKILL_WARNING, TERMINAL_TYPED_TEXT_WARNING } from "./reviewCopy";
import { useApiOnline } from "./useApiOnline";
import { useKeepFieldAboveBar } from "./useKeepFieldAboveBar";
import { usePickerRows } from "./usePickerRows";


const POPOVER_WIDTH = 410;

export interface ReviewPickerProps {
  api: ApiInstance;
  scope: ReviewScope;
  /** The comments being sent: the ticked rows, in send order (file, line, pin). */
  comments: ReviewComment[];
  /** Which When option is preselected: `later` for the tray's Schedule button, `now` otherwise. */
  initialWhen?: PickerWhen;
  /** The control that opened it: the popover sits against it and focus returns to it. */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Something left the panel (sent, scheduled, attached, new agent): the tray resets its selection. */
  onDone: () => void;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The send picker (`Send` board A): the real chat-box message field (`/` skills and `@` files work), this
 * scope's agents as a single-select list (the agent focused in the agent pane is preselected), a When control
 * (Now, or Later with a date and time in the same popup) and ONE primary Send / Schedule button; Attach to
 * agent, New agent and Copy as text are secondary. A popover on desktop, a `BottomSheet` at ≤768px. Esc
 * closes it (and is registered with the escape stack).
 */
export function ReviewPicker(props: ReviewPickerProps) {
  const { comments, onClose } = props;
  const isMobile = useIsMobile();
  const title = `Send ${plural(comments.length, "comment", "comments")}`;
  if (isMobile) {
    return (
      <BottomSheet open onClose={onClose} label={title}>
        <PickerBody {...props} title={title} />
      </BottomSheet>
    );
  }
  return <PickerPopover {...props} title={title} />;
}

function PickerPopover(props: ReviewPickerProps & { title: string }) {
  const { anchorRef, onClose, title } = props;
  const root = usePortalRoot();
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  useFocusTrap(ref, true);
  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current;
      const anchor = anchorRef.current;
      if (!el) return;
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - 16);
      // The visible height: an on-screen keyboard shrinks the visual viewport but not always the layout viewport.
      const vv = window.visualViewport;
      const viewH = vv ? Math.min(window.innerHeight, Math.round(vv.height + vv.offsetTop)) : window.innerHeight;
      const maxHeight = viewH - 16;
      const h = Math.min(el.offsetHeight || 420, maxHeight);
      if (!anchor) {
        setStyle({ position: "fixed", left: 8, bottom: 8, width, maxHeight, visibility: "visible" });
        return;
      }
      const pos = clampPopupPosition(anchor.getBoundingClientRect(), width, h, window.innerWidth, viewH);
      setStyle((prev) =>
        prev.top === pos.top && prev.left === pos.left && prev.width === width && prev.maxHeight === maxHeight && prev.visibility === "visible"
          ? prev
          : { position: "fixed", top: pos.top, left: pos.left, width, maxHeight, visibility: "visible" },
      );
    };
    place();
    // Rows load and the editor mounts after the first paint, so the height changes; re-place on every change.
    const ro = typeof ResizeObserver !== "undefined" && ref.current ? new ResizeObserver(place) : null;
    if (ro && ref.current) ro.observe(ref.current);
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [anchorRef, onClose]);

  return createPortal(
    <div
      ref={ref}
      className="comment-picker"
      style={style}
      role="dialog"
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <PickerBody {...props} />
    </div>,
    root,
  );
}

function PickerBody({ api, scope, comments, initialWhen = "now", onClose, onDone, title }: ReviewPickerProps & { title?: string }) {
  const rows = usePickerRows(api, scope, true);
  const online = useApiOnline(api);
  const isMobile = useIsMobile();
  const editorRef = useRef<SkillEditorHandle | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const scopeKey = `${scope.scopeKind}:${scope.scopeId}`;
  const draftKey = pickerDraftKey(scopeKey);
  const [message, setMessage] = useState(() => loadDraft(draftKey));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [when, setWhen] = useState<PickerWhen>(initialWhen);
  const [fireValue, setFireValue] = useState(defaultFireAt);
  const [clickError, setClickError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  // The agent focused in the agent pane when the picker opened; later focus changes are ignored.
  const [focusedAtOpen] = useState(() => useWorkspaceStore.getState().activeSessionId);
  // The user's own pick; once set, the selection never moves on its own.
  const [chosen, setChosen] = useState<string | null>(null);
  const { skillCommands, editorSeq, editorReady } = useSkillCommands(true, api);

  const worktree = useServerStore((s) => (scope.scopeKind === "worktree" ? s.worktrees.find((w) => w.id === scope.scopeId) : undefined));
  const mentions = useMemo<MentionEditorConfig>(
    () => ({
      api,
      projectId: scope.scopeKind === "project" ? scope.scopeId : (worktree?.projectId ?? null),
      worktreeId: scope.scopeKind === "worktree" ? scope.scopeId : null,
      selfSessionId: null,
    }),
    [api, scope, worktree?.projectId],
  );

  // The picker is a layer on the escape stack (above the comment box and the tray).
  useEffect(() => registerEscapeLayer("picker", () => (onClose(), true)), [onClose]);
  // Desktop: focus goes into the message field on open. Phones skip it so the keyboard doesn't cover the agent list.
  useEffect(() => {
    if (editorReady && !isMobile) editorRef.current?.focus();
  }, [editorReady, isMobile]);
  // Later: keep `min` and the validity of the chosen time current while the popup stays open.
  useEffect(() => {
    if (when !== "later") return undefined;
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [when]);

  const ids = useMemo(() => comments.map((c) => c.id), [comments]);
  const files = useMemo(() => new Set(comments.map((c) => c.path)).size, [comments]);
  const plain = renderDraftText(message).trim();
  const slashFirst = plain.startsWith("/");

  const def = useMemo(() => resolveDefaultRow(rows, focusedAtOpen), [rows, focusedAtOpen]);
  const selectedId = chosen ?? (def.kind === "row" ? def.id : null);
  const selected = rows.find((r) => r.id === selectedId);
  const enabled = useMemo(() => enabledRowIds(rows), [rows]);
  const later = when === "later";

  const richLimit = checkSendLimit(comments, "rich");
  const termBytes = blockBytes(comments, "") + utf8Bytes(plain);
  const termOver = termBytes > TERMINAL_SEND_MAX_BYTES;
  const overLimit = selected?.target === "rich" ? richLimit.over : selected?.target === "terminal" ? termOver : false;

  const fireCheck = later ? checkFireAt(fireValue) : null;
  const whenError = fireCheck && "error" in fireCheck ? fireCheck.error : null;
  const minValue = defaultFireAt();

  // Why the primary is disabled right now (shown under the bar and as its title); null when it can go.
  let block: string | null = null;
  if (!online) block = "Offline · reconnecting";
  else if (!chosen && def.kind === "waiting") block = "Checking agent support…";
  else if (!selected) block = enabled.length > 0 ? "Pick an agent." : "No agent here can take comments.";
  else if (selected.disabled || selected.target === "none") block = `${selected.name}: ${selected.why}`;
  else if (overLimit) block = SEND_LIMIT_HINT;
  else if (whenError) block = whenError;

  const finish = useCallback(() => {
    clearDraft(draftKey);
    onDone();
    onClose();
  }, [draftKey, onDone, onClose]);

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      finish();
    } catch (e) {
      setError(reviewErrorText(e, api, scope));
    } finally {
      setBusy(false);
    }
  }

  /** The one primary action: Send now (Rich Chat turn / Terminal delivery) or Schedule (both channels). */
  function go() {
    if (busy || block !== null || !selected) return;
    if (later) {
      // Time passes while the popup is open: check again at click.
      const chk = checkFireAt(fireValue);
      if ("error" in chk) {
        setClickError(chk.error);
        return;
      }
      void run(() => scheduleReview(api, scope, selected.id, ids, message, chk.iso, selected.target));
      return;
    }
    void run(async () => {
      if (selected.target === "rich") await sendToRichChat(api, scope, selected.id, ids, message);
      else await sendToTerminal(api, scope, selected.id, ids, message);
    });
  }

  const copy = async () => {
    if (!online) return;
    setError(null);
    try {
      const ok = await copyReviewAsText(api, scope, ids, message);
      setCopied(ok);
      if (!ok) setError("Couldn't copy to the clipboard.");
    } catch (e) {
      setError(reviewErrorText(e, api, scope));
    }
  };

  const choose = (id: string, focus = false) => {
    setChosen(id);
    if (focus) listRef.current?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(id)}"]`)?.focus();
  };

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [selectedId]);

  function onListKey(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      go();
      return;
    }
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-session-id]")?.dataset.sessionId ?? null;
    if (e.key === " " && target && enabled.includes(target)) {
      e.preventDefault();
      choose(target);
      return;
    }
    let next: string | null | undefined;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = stepRow(enabled, target ?? selectedId, 1);
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = stepRow(enabled, target ?? selectedId, -1);
    else if (e.key === "Home") next = enabled[0];
    else if (e.key === "End") next = enabled[enabled.length - 1];
    else return;
    e.preventDefault();
    if (next) choose(next, true);
  }

  // The Message field is the last block above the sticky bar: a focused field (keyboard open) must clear it.
  const fieldRef = useRef<HTMLDivElement>(null);
  const keepFieldAboveBar = useKeepFieldAboveBar(rootRef, fieldRef);

  const hasTerminalSelected = selected?.target === "terminal";
  const canAttach = selected?.target === "rich" && !later;
  const attachBlock = !online ? "Offline · reconnecting" : overLimit ? SEND_LIMIT_HINT : null;
  const primaryLabel = busy ? (later ? "Scheduling…" : "Sending…") : later ? "Schedule" : "Send";
  const warnings = hasTerminalSelected ? (
    <>
      {slashFirst ? (
        <div className="comment-picker__warn" role="note">
          {TERMINAL_SKILL_WARNING}
        </div>
      ) : null}
      <div className="comment-picker__warn">{TERMINAL_TYPED_TEXT_WARNING}</div>
    </>
  ) : null;
  const tabStopId = selectedId && enabled.includes(selectedId) ? selectedId : (enabled[0] ?? null);

  return (
    <div
      ref={rootRef}
      className="comment-picker__body"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          go();
        }
      }}
    >
      {title ? <div className="comment-picker__title">{title}</div> : null}
      <div className="comment-picker__cap">To</div>
      <div
        ref={listRef}
        role="radiogroup"
        aria-label="Agent"
        className="comment-picker__rows"
        onKeyDown={onListKey}
      >
        {rows.length === 0 ? <div className="comment-picker__empty">No agents here yet. Start one below.</div> : null}
        {rows.map((row) => (
          <ReviewPickerRow
            key={row.id}
            row={row}
            selected={row.id === selectedId}
            tabStop={row.id === tabStopId}
            onSelect={() => choose(row.id)}
          />
        ))}
      </div>

      <div className="comment-picker__cap comment-picker__cap--sep">When</div>
      <ReviewPickerWhen
        when={when}
        onWhen={(w) => {
          setWhen(w);
          setClickError(null);
          if (w === "later" && "error" in checkFireAt(fireValue)) setFireValue(defaultFireAt());
          if (w === "later") {
            // Phones: the When control sits at the sheet's bottom; keep the new date input above the sticky bar
            // (whatever its current height: error + warnings + buttons + reason), searching only inside this picker.
            requestAnimationFrame(() => {
              const root = rootRef.current;
              const whenEl = root?.querySelector<HTMLElement>(".comment-picker__when");
              if (!root || !whenEl) return;
              const bar = root.querySelector<HTMLElement>(".comment-picker__bar");
              whenEl.style.scrollMarginBottom = `${(bar?.offsetHeight ?? 0) + 16}px`;
              whenEl.scrollIntoView?.({ block: "nearest" });
            });
          }
        }}
        value={fireValue}
        onValue={(v) => {
          setFireValue(v);
          setClickError(null);
        }}
        min={minValue}
        error={whenError ?? clickError}
        onEnter={go}
      />
      {isMobile ? null : warnings}

      <div className="comment-picker__sep" />
      {!later ? (
        <button
          type="button"
          className="comment-picker__item"
          disabled={!online || busy}
          onClick={() => void run(async () => void (await newAgentWithComments(api, scope, ids, message)))}
        >
          <Plus size={14} aria-hidden />
          <span>New agent with these comments</span>
        </button>
      ) : null}
      <button
        type="button"
        className="comment-picker__item"
        disabled={!online}
        title={online ? undefined : COPY_OFFLINE_TITLE}
        onClick={() => void copy()}
      >
        <Copy size={14} aria-hidden />
        <span>{copied ? "Copied" : "Copy as text"}</span>
      </button>

      <div className="comment-picker__cap comment-picker__cap--sep">Message</div>
      <div ref={fieldRef} className="comment-picker__field" onFocus={keepFieldAboveBar}>
        {editorReady ? (
          <SkillEditor
            ref={editorRef}
            editorKey={`review-picker-${scopeKey}-${editorSeq}`}
            initialText={message}
            commands={skillCommands}
            mentions={mentions}
            ariaLabel="Message for the agent"
            placeholder="Message for the agent (optional)"
            className="comment-picker__editor"
            enterBehavior="newline"
            onChangeText={(next) => {
              setMessage(next);
              saveDraft(draftKey, next);
            }}
            onSubmit={() => {}}
          />
        ) : (
          <div className="comment-picker__editor comment-picker__editor--loading" aria-hidden />
        )}
        <div className="comment-picker__meta">
          {`+ ${plural(comments.length, "comment", "comments")} · ${plural(files, "file", "files")} · / skills and @ files work here.${canAttach ? " Need files or a different model? Use Attach to agent." : ""}`}
        </div>
      </div>

      <div className="comment-picker__bar" data-popover-floor>
        {error ? (
          <div className="comment-picker__error" role="alert">
            {error}
          </div>
        ) : null}
        {isMobile ? warnings : null}
        <div className="comment-picker__bar-row">
          {canAttach && selected ? (
            <button
              type="button"
              className="comment-btn"
              disabled={busy || attachBlock !== null}
              title={attachBlock ?? "Puts these comments in the agent’s chat box. Nothing is sent yet."}
              onClick={() => void run(() => attachFromPicker(api, scope, selected.id, ids, message))}
            >
              Attach to agent
            </button>
          ) : null}
          <span className="comment-picker__bar-sp" />
          <button type="button" className="comment-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="comment-btn comment-btn--primary comment-picker__primary"
            disabled={busy || block !== null}
            title={block ?? undefined}
            aria-label={selected ? `${later ? "Schedule for" : "Send to"} ${selected.name}` : primaryLabel}
            aria-describedby={block ? "comment-picker-block" : undefined}
            onClick={go}
          >
            {primaryLabel}
          </button>
        </div>
        {block ? (
          <div id="comment-picker-block" className="comment-picker__block">
            {block}
          </div>
        ) : null}
      </div>
      <span className="comment-picker__live" aria-live="polite">
        {copied ? "Copied to the clipboard" : ""}
      </span>
    </div>
  );
}
