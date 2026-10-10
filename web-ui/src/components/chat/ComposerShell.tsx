import { Fragment, useEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Paperclip } from "lucide-react";
import type { DraftAttachment } from "@/hooks/useAttachmentDrafts";
import { AttachmentChip } from "./AttachmentChip";

/** True when a drag carries OS files (not text/a Lexical chip/a dnd-kit tab).
 *  `types` is the only thing readable during dragenter/dragover; `files` is
 *  checked as well for synthetic test events that only populate it. */
function dragHasFiles(e: { dataTransfer: DataTransfer | null }): boolean {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (Array.from(dt.types ?? []).includes("Files")) return true;
  return (dt.files?.length ?? 0) > 0;
}

/** Elements inside the shell that must keep their own press behaviour. */
const INTERACTIVE_SELECTOR =
  'button, a, input, select, textarea, label, kbd, [role="switch"], [role="button"], [contenteditable], .chat-skill-editor, .chat-composer__chips';

interface ComposerShellProps {
  /** Extra modifier class on the outer `.chat-composer` (e.g. `chat-composer--draft`). */
  className?: string;
  /** Attachment chips (uploaded or staged). */
  attachments: DraftAttachment[];
  onRemoveAttachment: (id: string) => void;
  /** Inline error/notice under the chips. */
  error?: ReactNode;
  /** Files picked via the paperclip or dropped onto the composer. */
  onFiles: (files: File[]) => void;
  /** Disables the paperclip AND drop-to-attach. */
  attachDisabled?: boolean;
  /** Tooltip for the paperclip (e.g. why it is disabled). */
  attachTitle?: string;
  /** The editor (a `<SkillEditor>`) — owned by the caller since its wiring differs. */
  children: ReactNode;
  /** Focus the caller's editor. When provided, pressing on dead space inside
   *  the shell (status row, padding, toolbar gaps) focuses it, so the user
   *  doesn't have to aim at the text line. */
  onFocusEditor?: () => void;
  /** Toolbar items after the paperclip (channel toggle, model/mode chips). */
  toolbarStart?: ReactNode;
  /** Toolbar items after the spacer (schedule, send/start). */
  toolbarEnd?: ReactNode;
  /** Hint row under the shell (see `ComposerHint`). */
  hint?: ReactNode;
  /** Extra rows after the hint (e.g. "Skills loading…"). */
  footer?: ReactNode;
}

/**
 * Presentational composer shared by the Rich Chat `Composer` and the draft
 * agent's `DraftComposer`: bordered shell (status row, chips, editor,
 * toolbar), paperclip + drag-and-drop attachments, and the hint row. Holds no
 * send/upload logic — callers decide what an attachment *is* (uploaded
 * immediately vs. staged `File`s) and what the toolbar buttons do.
 */
export function ComposerShell({
  className,
  attachments,
  onRemoveAttachment,
  error,
  onFiles,
  attachDisabled,
  attachTitle,
  children,
  onFocusEditor,
  toolbarStart,
  toolbarEnd,
  hint,
  footer,
}: ComposerShellProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  // dragenter/dragleave fire for every child boundary crossed (editor, chips,
  // buttons) — a depth counter keeps the highlight from flickering off while
  // the pointer is still inside the composer.
  const dragDepth = useRef(0);

  // A file dropped just outside the composer would otherwise make the browser
  // navigate to it, losing the whole page. Swallow file drops nobody claimed
  // (`defaultPrevented` is false) while a composer is mounted; real drop
  // targets (this one included) preventDefault first, so they're unaffected.
  useEffect(() => {
    const guard = (e: globalThis.DragEvent) => {
      if (e.defaultPrevented || !dragHasFiles(e)) return;
      e.preventDefault();
      if (e.type === "dragover" && e.dataTransfer) e.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, []);

  function onShellMouseDown(e: ReactMouseEvent<HTMLDivElement>) {
    if (!onFocusEditor || e.button !== 0) return;
    // Anything that is (or sits inside) a control, the editor, or an
    // attachment chip keeps its own behaviour — only dead space focuses.
    if ((e.target as Element).closest(INTERACTIVE_SELECTOR)) return;
    // Keep the press from moving focus to the shell/body and blurring the
    // editor we are about to focus.
    e.preventDefault();
    onFocusEditor();
  }

  function onDragEnter(e: DragEvent) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    if (!attachDisabled) setDragOver(true);
  }
  function onDragOver(e: DragEvent) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = attachDisabled ? "none" : "copy";
    if (!attachDisabled && !dragOver) setDragOver(true);
  }
  function onDragLeave(e: DragEvent) {
    if (!dragHasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  }
  function onDrop(e: DragEvent) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    if (attachDisabled) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) onFiles(files);
  }

  return (
    <div
      className={`chat-composer${className ? ` ${className}` : ""}${dragOver ? " chat-composer--dragover" : ""}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="chat-composer__shell" onMouseDown={onShellMouseDown}>
        {dragOver ? (
          <div className="chat-composer__drop-overlay" aria-hidden>
            Drop files to attach
          </div>
        ) : null}
        {attachments.length > 0 ? (
          <div className="chat-composer__chips">
            {attachments.map((d) => (
              <AttachmentChip
                key={d.attachment.id}
                attachment={d.attachment}
                status={d.status}
                onRemove={onRemoveAttachment}
              />
            ))}
          </div>
        ) : null}

        {error ? <div className="chat-composer__error">{error}</div> : null}

        {children}

        <div className="chat-composer__toolbar">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="chat-composer__file-input"
            aria-label="Attach files"
            tabIndex={-1}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) onFiles(files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="chat-composer__attach"
            aria-label="Attach files"
            title={attachTitle ?? "Attach files"}
            disabled={attachDisabled}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={14} />
          </button>
          {toolbarStart}
          <span className="chat-composer__spacer" aria-hidden />
          {toolbarEnd}
        </div>
      </div>

      {hint ? <div className="chat-composer__hint">{hint}</div> : null}
      {footer}
    </div>
  );
}

/** A keyboard shortcut rendered as a keycap (`<kbd>`). */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="chat-kbd">{children}</kbd>;
}

/** One `[keys] label` hint item; `keys` may hold alternatives (`["Enter", "→"]` → "[Enter] or [→]"). */
export interface HintItem {
  keys: string[];
  label: string;
}

/** The ` · `-separated shortcut row under a composer, each combo in a keycap. */
export function ComposerHint({ items, prefix }: { items: HintItem[]; prefix?: ReactNode }) {
  return (
    <>
      {prefix ? <>{prefix} · </> : null}
      {items.map((item, i) => (
        <Fragment key={`${item.label}-${i}`}>
          {i > 0 ? " · " : null}
          <span className="chat-composer__hint-item">
            {item.keys.map((k, j) => (
              <Fragment key={k}>
                {j > 0 ? " or " : null}
                <Kbd>{k}</Kbd>
              </Fragment>
            ))}{" "}
            {item.label}
          </span>
        </Fragment>
      ))}
    </>
  );
}
