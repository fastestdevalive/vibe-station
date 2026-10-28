import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReviewComment } from "@/api/types";
import { Banner } from "@/components/ui/Banner";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { useIsTouch } from "@/hooks/useIsTouch";
import { useIsMobile } from "@/hooks/useIsMobile";
import { Chip } from "@/components/ui/Chip";
import { SkillEditor, type SkillEditorHandle } from "@/components/chat/SkillEditor";
import type { MentionEditorConfig } from "@/components/mentions/types";
import { registerEscapeLayer } from "@/lib/escapeLayers";
import { renderDraftText, serializeDraftSegments } from "@/lib/mentions";
import { showInvisibles } from "./visibleText";
import { isInsideCommentLayer, useOutsideTap } from "./useOutsideTap";
import { loadDraft, saveDraft, saveDraftAnchor } from "./commentDrafts";
import type { CommentAnchor } from "./types";

/** `Limit reached — delete or send some comments` (also the disabled reason of Add). */
export const LIMIT_REACHED_TEXT = "Limit reached — delete or send some comments";
export const OFFLINE_ADD_TEXT = "Offline · reconnecting";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPod|iPad/i.test(navigator.platform ?? navigator.userAgent ?? "");
export const submitHint = () => (isMac() ? "⌘↵" : "Ctrl+↵");

/** Plain stored text → the editor's draft grammar (literal `{` / `\` escaped, never read as a token). */
export const toDraft = (plain: string): string => serializeDraftSegments([{ type: "text", text: plain }]);

/** Why the comment under edit disappeared: removed by another device. */
export type RemovedNotice = { reason: "deleted" } | { reason: "sent" | "scheduled" };

export interface CommentBoxProps {
  mode: "new" | "edit" | "view";
  /** `L129 · +` — `anchorLabel`. */
  label: string;
  /** The quoted text (first line shown). */
  quote: string;
  /** Saved comment (view / edit). */
  comment?: ReviewComment;
  /** Draft storage key (new / edit); the text is restored from it on mount. */
  draftKey?: string;
  /** New comment: stored beside the draft so a reload can reopen the box where it was. */
  draftAnchor?: CommentAnchor;
  /** Seed when no draft is stored (edit: the saved text). */
  seedText?: string;
  mentions?: MentionEditorConfig;
  offline?: boolean;
  capReached?: boolean;
  /** The quoted text changed while the user was typing (saved as outdated). */
  stale?: boolean;
  removed?: RemovedNotice;
  /** Server / validation error of the last save. */
  error?: string | null;
  busy?: boolean;
  /** Where an attached comment is attached (view meta), e.g. the agent's name. */
  attachedLabel?: string;
  onSave?: (plainText: string) => void;
  onCancel?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  /** Deleted elsewhere: re-create it with the current text. */
  onRestore?: (plainText: string) => void;
  onDiscard?: () => void;
  onCopyText?: (plainText: string) => void;
  /** Floating box (rendered markdown): an outside tap closes it when clean, asks to discard when it holds text. */
  onDismiss?: () => void;
  /** Reports whether the box holds unsaved text / changes (the provider decides whether a pin tap may replace it). */
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * The inline comment row (`Changes` board `.cmt`): view card, add box and edit box. The editor is the shared
 * `SkillEditor` in comment mode (`@` files only, no `/` skills, Enter = newline, Cmd/Ctrl+Enter = submit).
 * Esc goes through the escape-layer stack; a box holding unsaved text asks `Discard this comment?` first.
 */
export function CommentBox(props: CommentBoxProps) {
  if (props.mode === "view") return <CommentCard {...props} comment={props.comment!} />;
  return <CommentEditor {...props} />;
}

function QuoteHeader({ label, quote, prefix }: { label: string; quote: string; prefix?: string }) {
  const head = quote.split("\n", 1)[0] ?? "";
  return (
    <div className="comment-box__q" title={showInvisibles(quote)}>
      {prefix ? <span className="comment-box__q-prefix">{prefix} · </span> : null}
      <span className="comment-box__q-label">{label}</span>
      {head ? <span className="comment-box__q-text">{`  ${showInvisibles(head)}`}</span> : null}
    </div>
  );
}

function CommentCard({ label, quote, comment, offline, attachedLabel, onEdit, onDelete }: CommentBoxProps & { comment: ReviewComment }) {
  const meta = comment.attachedTo ? `attached · ${attachedLabel ?? "chat box"}` : "unsent";
  return (
    <div
      className="comment-box comment-box--view"
      role="group"
      aria-label={`Comment #${comment.pin}`}
      data-comment-card={comment.id}
    >
      <QuoteHeader label={label} quote={quote} prefix={`#${comment.pin}`} />
      <div className="comment-box__text">{showInvisibles(comment.text)}</div>
      {comment.anchor === "outdated" ? (
        <div className="comment-box__note">This quote is no longer in the file · showing where it was</div>
      ) : null}
      <div className="comment-box__row">
        <span className="comment-box__meta">{meta}</span>
        {comment.anchor === "outdated" ? (
          <Chip tone="warn" size="sm">
            outdated
          </Chip>
        ) : comment.anchor === "cant_check" ? (
          <Chip size="sm" title={comment.anchorReason === "watch_limit" ? "Too many watched files (watch limit)" : "File too large to check"}>
            can’t check
          </Chip>
        ) : null}
        <span className="comment-box__spacer" />
        <button type="button" className="comment-btn comment-btn--ghost" onClick={onEdit} disabled={offline} title={offline ? OFFLINE_ADD_TEXT : undefined}>
          Edit
        </button>
        <button type="button" className="comment-btn comment-btn--ghost comment-btn--danger" onClick={onDelete} disabled={offline} title={offline ? OFFLINE_ADD_TEXT : undefined}>
          Delete
        </button>
      </div>
    </div>
  );
}

function CommentEditor({
  mode,
  label,
  quote,
  comment,
  draftKey,
  draftAnchor,
  seedText = "",
  mentions,
  offline,
  capReached,
  stale,
  removed,
  error,
  busy,
  onSave,
  onCancel,
  onRestore,
  onDiscard,
  onCopyText,
  onDismiss,
  onDirtyChange,
}: CommentBoxProps) {
  const editing = mode === "edit";
  const initial = useMemo(() => {
    const stored = draftKey ? loadDraft(draftKey) : "";
    return stored || (seedText ? toDraft(seedText) : "");
    // Read once per box: the editor is uncontrolled and keyed.
  }, []);
  const [draft, setDraft] = useState(initial);
  const [hasContent, setHasContent] = useState(initial.trim().length > 0);
  const [confirming, setConfirming] = useState(false);
  const editorRef = useRef<SkillEditorHandle>(null);
  // ≤768px the add / edit box is a bottom sheet above the keyboard (R90); there is no shortcut hint on touch.
  const sheet = useIsMobile();
  const touch = useIsTouch();

  const plain = useCallback((d: string) => renderDraftText(d), []);
  const dirty = editing ? plain(draft) !== seedText : hasContent;

  const requestClose = useCallback(() => {
    if (confirming) {
      setConfirming(false);
      editorRef.current?.focus();
      return;
    }
    if (dirty) setConfirming(true);
    else onCancel?.();
  }, [confirming, dirty, onCancel]);
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  useEffect(() => {
    onDirtyChange?.(dirty || !!removed);
  }, [dirty, removed, onDirtyChange]);
  // Floating box: a tap outside closes it when clean; one holding text (or a removed notice) asks instead, never discards.
  useOutsideTap(!!onDismiss && !sheet, {
    inside: (t) => isInsideCommentLayer(t, { pins: false }),
    onTap: () => {
      if (confirming) return;
      if (dirty || removed) setConfirming(true);
      else onDismiss?.();
    },
  });

  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(
    () => registerEscapeLayer("comment-box", () => requestCloseRef.current(), () => boxRef.current?.closest(".tool-panel") ?? null),
    [],
  );
  useEffect(() => {
    if (removed) return undefined;
    // The sheet takes focus when it opens (its own effect runs after this one), so wait a tick there.
    if (!sheet) {
      editorRef.current?.focus();
      return undefined;
    }
    const id = window.setTimeout(() => editorRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [removed, sheet]);

  const onChange = (text: string, has: boolean) => {
    setDraft(text);
    setHasContent(has);
    if (draftKey) {
      saveDraft(draftKey, text);
      if (text && draftAnchor) saveDraftAnchor(draftKey, draftAnchor);
    }
  };

  const blockedReason = offline ? OFFLINE_ADD_TEXT : !editing && capReached ? LIMIT_REACHED_TEXT : null;
  const text = plain(draft).trim();
  const canSubmit = !blockedReason && !busy && text.length > 0 && !removed;
  const submit = () => {
    if (canSubmit) onSave?.(text);
  };

  const notice = removed ? (
    removed.reason === "deleted" ? (
      <Banner
        tone="error"
        actions={
          <>
            <button type="button" className="comment-btn" onClick={() => onRestore?.(text)} disabled={offline || text.length === 0}>
              Restore
            </button>
            <button type="button" className="comment-btn" onClick={onDiscard}>
              Discard
            </button>
          </>
        }
      >
        Deleted on another device.
      </Banner>
    ) : (
      <Banner
        tone="info"
        actions={
          <>
            <button type="button" className="comment-btn" onClick={onDiscard}>
              Discard
            </button>
            <button type="button" className="comment-btn" onClick={() => onCopyText?.(text)}>
              Copy text
            </button>
          </>
        }
      >
        {removed.reason === "scheduled" ? "Scheduled from another device." : "Sent from another device."}
      </Banner>
    )
  ) : stale ? (
    <Banner tone="warn">The quoted text changed while you were typing. Your comment will be saved as outdated.</Banner>
  ) : null;

  const box = (
    <div
      ref={boxRef}
      className={`comment-box comment-box--${mode}`}
      role="group"
      aria-label={editing ? `Editing comment ${comment?.pin ?? ""}`.trim() : "New comment"}
      data-comment-box={mode}
    >
      {notice}
      <QuoteHeader
        label={editing ? `Editing comment ${comment?.pin ?? ""} · ${label.split(" · ")[0]}` : label}
        quote={quote}
      />
      <SkillEditor
        ref={editorRef}
        editorKey={`comment-${comment?.id ?? draftKey ?? "new"}`}
        initialText={initial}
        mentions={mentions}
        ariaLabel="Comment"
        placeholder="Comment for the agent…"
        className="comment-box__editor"
        enterBehavior="newline"
        disabled={!!removed && removed.reason !== "deleted"}
        onChangeText={onChange}
        onSubmit={submit}
        onEscape={(e) => {
          // Native bubble listeners above (the tools pane's Esc handler) must not also act on this key.
          e?.stopPropagation();
          requestClose();
        }}
      />
      {error ? (
        <div className="comment-box__error" role="alert">
          {error}
        </div>
      ) : null}
      {confirming ? (
        <div className="comment-box__row comment-box__confirm" role="alertdialog" aria-label="Discard this comment?">
          <span className="comment-box__meta comment-box__meta--strong">Discard this comment?</span>
          <span className="comment-box__spacer" />
          <button
            type="button"
            className="comment-btn"
            onClick={() => {
              setConfirming(false);
              editorRef.current?.focus();
            }}
          >
            Keep editing
          </button>
          <button type="button" className="comment-btn comment-btn--danger" onClick={onCancel}>
            Discard
          </button>
        </div>
      ) : (
        <div className="comment-box__row">
          <span className="comment-box__meta">
            {blockedReason ?? (touch ? "" : `${submitHint()} to ${editing ? "save" : "add"} · Esc to cancel`)}
          </span>
          <span className="comment-box__spacer" />
          <button type="button" className="comment-btn" onClick={requestClose}>
            Cancel
          </button>
          <button
            type="button"
            className="comment-btn comment-btn--primary"
            disabled={!canSubmit}
            title={blockedReason ?? undefined}
            onClick={submit}
          >
            {editing ? "Save" : "Add comment"}
          </button>
        </div>
      )}
    </div>
  );

  return sheet ? (
    <BottomSheet open onClose={requestClose} label={editing ? "Edit comment" : "Add comment"}>
      {box}
    </BottomSheet>
  ) : (
    box
  );
}
