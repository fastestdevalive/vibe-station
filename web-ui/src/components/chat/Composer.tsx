import { useCallback, useEffect, useRef, useState } from "react";
import { Clock, SendHorizontal, Square } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { Attachment, Command, UsageInfo } from "@/api/types";
import { useAttachmentDrafts } from "@/hooks/useAttachmentDrafts";
import { loadDraft, useComposerDraft } from "@/hooks/useComposerDraft";
import { apiErrorText } from "@/lib/apiErrorText";
import { migrateV1Draft } from "@/lib/skillInvocation";
import { ContextMeter } from "./ContextMeter";
import { ComposerHint, ComposerShell, type HintItem } from "./ComposerShell";
import { ModelSwitch } from "./ModelSwitch";
import { ScheduleSendPopover } from "./ScheduleSendPopover";
import { SkillEditor, useSoftKeyboardVisible, type SkillEditorHandle } from "./SkillEditor";

/** How long the Send button is held (disabled) at its position after OUR OWN
 *  send emptied the box while a turn is still running — see `justSent`. */
const SEND_SETTLE_MS = 700;

interface ComposerProps {
  api: ApiInstance;
  sessionId: string;
  /** Enqueue a turn (message + resolved attachment ids). `queue: true` forces
   *  a FIFO enqueue (never steers) — the Ctrl/Cmd+Enter path. */
  onSend: (message: string, attachmentIds: string[], queue?: boolean) => Promise<"queued" | "steered" | undefined | void> | void;
  /** A turn is active — show Stop instead of disabling. */
  busy?: boolean;
  onStop?: () => void;
  /** True while a stop request is pending/in flight. */
  stopPending?: boolean;
  /** When true and busy, the send button label indicates steering instead of queuing. */
  canSteer?: boolean;
  /** Disable input entirely (e.g. session not ready). */
  disabled?: boolean;
  /** Prefill text (e.g. salvaged from a failed queued-turn edit, A9). */
  initialText?: string;
  /** Prefill attachment chips (salvaged from a failed edit, A9). */
  initialAttachments?: Attachment[];
  /** Ref to the editor handle so callers can return focus here (e.g. Escape
   *  from the queued-message tray). */
  textareaRef?: React.RefObject<SkillEditorHandle | null>;
  /** Session's slash-command/skill catalog (`session:meta.commands`).
   *  `undefined` means the catalog hasn't loaded yet — `/` renders as plain
   *  text, no popover, no row (Requirement 11). */
  commands?: Command[];
  /** Whether to grab keyboard focus (and show the IME) on mount. Defaults to
   *  `true` for the standalone/first-run case; the hosting pane passes
   *  `false` in canvas mode or on a touch device, so focus is never yanked
   *  onto a pane that shouldn't pop the IME. */
  focusOnMount?: boolean;
  /** Current model for this session, shown as a live-switching dropdown in the toolbar. */
  model?: string;
  /** CLI id for the model dropdown (required to enable ModelSwitch). */
  cli?: string;
  /** Mode name shown as a secondary chip in the toolbar. */
  modeName?: string;
  /** The user switched the model away from the mode's default — the chip reads
   *  "started as <mode>" so it doesn't claim the mode's model is in use. */
  modelOverridden?: boolean;
  /** Overrides the idle "Ready" label (e.g. "⚠ Error" after a failed turn). */
  statusLabel?: string;
  /** Turns waiting in the queue — shown next to "Working…" while busy. */
  queuedCount?: number;
  /** Session usage — drives the context-window meter in the status row. */
  usage?: UsageInfo;
  /** Called when the user confirms a scheduled send. If not provided, the schedule button is hidden. */
  onScheduleSend?: (message: string, attachmentIds: string[], fireAt: string) => Promise<void>;
}

/** Rich Chat message composer: skill-aware editor + send/stop/schedule, with
 *  attachments uploaded immediately to the session. Layout, chips and
 *  drag-drop live in the shared `ComposerShell` (also used by DraftComposer). */
export function Composer({
  api,
  sessionId,
  onSend,
  busy,
  onStop,
  stopPending,
  canSteer,
  disabled,
  initialText,
  initialAttachments,
  textareaRef,
  commands,
  focusOnMount = true,
  model,
  cli,
  modeName,
  modelOverridden,
  usage,
  statusLabel,
  queuedCount = 0,
  onScheduleSend,
}: ComposerProps) {
  const commandNames = (commands ?? []).map((c) => c.name);

  // Salvaged text (from a failed queued-turn edit) wins over any stored
  // draft; otherwise seed from the persisted draft for this session,
  // migrated once from the v1 canonical form if needed (Phase 7B.7). `text`
  // is the flat brace-token wire string (Decision 2), not display text.
  const [text, setText] = useState(() => migrateV1Draft(initialText ?? loadDraft(sessionId), commandNames));
  const [hasContent, setHasContent] = useState(() => text.trim().length > 0);
  const draft = useComposerDraft(sessionId);

  const [argFocused, setArgFocused] = useState(false);
  const softKeyboardVisible = useSoftKeyboardVisible();

  const { drafts, readyAttachments, error, uploadFiles, removeDraft, reset } = useAttachmentDrafts(
    api,
    sessionId,
    initialAttachments,
  );
  const [sending, setSending] = useState(false);
  const scheduleAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [schedulePopoverOpen, setSchedulePopoverOpen] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const internalEditorRef = useRef<SkillEditorHandle | null>(null);
  const setEditorRef = useCallback(
    (el: SkillEditorHandle | null) => {
      internalEditorRef.current = el;
      if (textareaRef) textareaRef.current = el;
    },
    [textareaRef],
  );

  const hasAnyContent = hasContent || readyAttachments.length > 0;
  const canSend = !disabled && !sending && hasAnyContent;

  // A successful send CLEARS the box while the turn may still be busy —
  // hold the Send branch, disabled, for a short settle window after our own
  // send so the same screen position can't flip to Stop under the user's
  // still-descending click.
  const [justSent, setJustSent] = useState(false);
  useEffect(() => {
    if (!justSent) return;
    const id = window.setTimeout(() => setJustSent(false), SEND_SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [justSent]);

  // Auto-focus the composer on mount (mirrors term.focus() in TerminalPane).
  // Composer is re-keyed on sessionId in ChatPane so this fires on every
  // agent/worktree switch, letting the user type immediately without tapping —
  // but ONLY when the hosting pane passed focusOnMount=true (false in canvas
  // mode or on a touch device). When false we don't steal focus / pop the IME.
  useEffect(() => {
    if (focusOnMount) {
      internalEditorRef.current?.focus();
    }
    // Focus decision is intentionally mount-time only (the component is
    // re-keyed on sessionId so it remounts on every agent/worktree switch).
    // It must NOT refocus on a `focusOnMount` flip mid-view (e.g. toggling
    // into canvas mode while the user is already looking at the pane) — that
    // would yank the caret away from wherever it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSend(queue: boolean) {
    if (!canSend) return;
    const message = internalEditorRef.current?.getText().trim() ?? text.trim();
    const ids = readyAttachments.map((a) => a.id);
    setSending(true);
    try {
      // `queue` is passed only for the Ctrl/Cmd+Enter path, keeping the plain
      // Enter/button call identical (2 args) for existing callers/tests.
      if (queue) await onSend(message, ids, true);
      else await onSend(message, ids);
      internalEditorRef.current?.clear();
      setText("");
      setHasContent(false);
      draft.clear();
      reset();
      setJustSent(true);
    } finally {
      setSending(false);
    }
  }

  async function handleSchedule(fireAt: string) {
    if (!onScheduleSend || sending) return;
    const message = internalEditorRef.current?.getText().trim() ?? text.trim();
    const ids = readyAttachments.map((a) => a.id);
    // `sending` also blocks Enter-to-send while the request is in flight, so
    // the same text can't be both scheduled and sent.
    setSending(true);
    setScheduleError(null);
    try {
      await onScheduleSend(message, ids, fireAt);
    } catch (e) {
      // Keep the popover open and the text untouched so the user can fix the
      // time and try again — never leave them believing it was scheduled.
      setScheduleError(apiErrorText(e, "Couldn't schedule the message."));
      return;
    } finally {
      setSending(false);
    }
    setSchedulePopoverOpen(false);
    internalEditorRef.current?.clear();
    setText("");
    setHasContent(false);
    draft.clear();
    reset();
    // The popover held focus; hand it back so the user can keep typing.
    internalEditorRef.current?.focus();
  }

  const hintItems: HintItem[] = argFocused
    ? [
        { keys: ["Enter", "→"], label: "exits to the message" },
        { keys: ["Backspace"], label: "removes an argument, then the skill" },
        { keys: ["Ctrl/⌘ + Enter"], label: "queues" },
      ]
    : softKeyboardVisible
      ? [
          { keys: ["Enter"], label: "newline" },
          { keys: ["Ctrl/⌘ + Enter"], label: "to queue & send" },
        ]
      : [
          { keys: ["Enter"], label: "to send" },
          { keys: ["Ctrl/⌘ + Enter"], label: "to queue" },
          { keys: ["Shift + Enter"], label: "newline" },
        ];

  return (
    <ComposerShell
      attachments={drafts}
      onRemoveAttachment={removeDraft}
      error={error}
      onFiles={(files) => void uploadFiles(files)}
      onFocusEditor={() => internalEditorRef.current?.focus()}
      attachDisabled={disabled}
      status={
        <div className="chat-composer__status">
          <span>{busy && !justSent ? (queuedCount > 0 ? `Working… · ${queuedCount} queued` : "Working…") : (statusLabel ?? "Ready")}</span>
          <ContextMeter usage={usage} />
          {busy && !justSent ? (
            <button
              type="button"
              className="chat-composer__stop-btn"
              onClick={onStop}
              aria-label="Stop turn"
              title="Stop"
              disabled={stopPending}
            >
              <Square size={10} fill="currentColor" />
            </button>
          ) : null}
        </div>
      }
      toolbarStart={
        <>
          {cli && cli !== "cursor" ? (
            <ModelSwitch api={api} sessionId={sessionId} cli={cli} model={model} />
          ) : model ? (
            <span className="chat-composer__model-chip" title={model}>
              {model}
            </span>
          ) : null}
          {modeName ? (
            <span
              className={`chat-composer__mode-chip${modelOverridden ? " chat-composer__mode-chip--overridden" : ""}`}
              title={modelOverridden ? `Started as: ${modeName}` : modeName}
            >
              {modelOverridden ? `started as ${modeName}` : modeName}
            </span>
          ) : null}
        </>
      }
      toolbarEnd={
        <>
          {onScheduleSend ? (
            <>
              <button
                ref={scheduleAnchorRef}
                type="button"
                className="chat-composer__schedule-btn"
                aria-label="Schedule send"
                title="Schedule send"
                disabled={disabled || !hasAnyContent}
                onClick={() => setSchedulePopoverOpen((v) => !v)}
              >
                <Clock size={14} />
              </button>
              <ScheduleSendPopover
                open={schedulePopoverOpen}
                anchorRef={scheduleAnchorRef}
                error={scheduleError}
                busy={sending}
                onSchedule={(fireAt) => void handleSchedule(fireAt)}
                onClose={() => {
                  setSchedulePopoverOpen(false);
                  setScheduleError(null);
                  internalEditorRef.current?.focus();
                }}
              />
            </>
          ) : null}
          <button
            type="button"
            className="btn btn--primary chat-composer__send"
            aria-label={
              busy && canSteer
                ? "Interrupts and steers the running turn"
                : busy
                  ? "Send message (queues after current turn)"
                  : "Send message"
            }
            title={
              busy && canSteer
                ? "Interrupts and steers the running turn"
                : busy
                  ? "Sends after the current turn finishes"
                  : undefined
            }
            disabled={!canSend}
            onClick={() => void handleSend(false)}
          >
            <SendHorizontal size={13} />
            <span>Send</span>
          </button>
        </>
      }
      hint={
        <ComposerHint
          items={hintItems}
          {...(argFocused ? {} : { prefix: <><span aria-hidden>⤓</span> Drop files here</> })}
        />
      }
      footer={
        commands === undefined ? (
          // Requirement 11 / Decision "catalog-unloaded": no row, no popover —
          // "/" renders as plain text until the session's command catalog loads.
          <div className="chat-composer__hint chat-composer__hint--skills">
            Skills loading… "/" inserts plain text until the catalog is ready.
          </div>
        ) : null
      }
    >
      <SkillEditor
        ref={setEditorRef}
        editorKey={sessionId}
        initialText={text}
        commands={commands}
        disabled={disabled}
        ariaLabel="Message"
        placeholder="Type a message…"
        className="chat-composer__textarea"
        onChangeText={(next, content) => {
          setText(next);
          draft.save(next);
          setHasContent(content);
        }}
        onSubmit={() => void handleSend(false)}
        onCtrlEnter={() => void handleSend(true)}
        onArgFocusChange={setArgFocused}
      />
    </ComposerShell>
  );
}
