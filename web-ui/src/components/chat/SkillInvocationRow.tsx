import { forwardRef, useRef } from "react";

export interface SkillInvocationRowProps {
  /** The chip's name + current args (node state, not document text — Decision 4). */
  prefix: { name: string; args: string };
  /** From the session's command catalog entry — used as the arg input's placeholder. */
  argumentHint?: string;
  /** Rebuild the node's args state with a new value. */
  onArgsChange: (args: string) => void;
  /** Backspace pressed while the arg input is already empty — removes the
   *  chip and replaces it with a literal `/`, caret after it, popover
   *  reopened (spec correction: progressive-backspace collapse, no ✕, no
   *  armed state). */
  onCollapseToSlash: () => void;
  /** Enter (any caret position) or "→" at end of the arg input — focus drops
   *  to the document, just after the chip. */
  onExitToProse: () => void;
  /** "←" at start of the arg input (value empty or caret at 0) — focus drops
   *  to the document, just before the chip. */
  onExitToProseBefore: () => void;
  /** Parity with the editor's own Ctrl+Enter handling — the ONLY way a
   *  keystroke inside the row can trigger a parent action (send/save). Enter
   *  alone is a row-owned no-op everywhere — it never sends/saves/discards. */
  onCtrlEnter: () => void;
}

/** Collapse a pasted/typed newline to a single space — an unfiltered newline
 *  in the arg input would silently move the token's own boundary. */
function sanitizeArgs(value: string): string {
  return value.replace(/\r?\n/g, " ");
}

/**
 * Shared skill-invocation chip content: `/name` + an argument `<input>`,
 * rendered inline by `SkillChipNode`'s `decorate()` — this is the atomic
 * Lexical DecoratorNode's DOM content, not an absolutely-positioned overlay.
 * Mounted identically at all three sites (Composer, QueuedTray's and
 * MessageList's `QueuedTurnEditor`) via the shared `<SkillEditor>`. The
 * forwarded ref reaches the arg `<input>` DOM node so a caller can move
 * focus into it.
 */
export const SkillInvocationRow = forwardRef<HTMLInputElement, SkillInvocationRowProps>(
  function SkillInvocationRow(
    {
      prefix,
      argumentHint,
      onArgsChange,
      onCollapseToSlash,
      onExitToProse,
      onExitToProseBefore,
      onCtrlEnter,
    },
    ref,
  ) {
    // Compact autosize: the arg input widens with its content (in `ch`
    // units, so it tracks the font, not a pixel guess) up to the chip's own
    // CSS `max-width` cap — beyond that it scrolls horizontally natively
    // (chat.css). §9: a minimum ~4ch width even with no hint, so there is
    // always a visible, clickable target.
    const argInputWidthCh = Math.max(prefix.args.length, argumentHint?.length ?? 0, 4);

    const localInputRef = useRef<HTMLInputElement | null>(null);
    const setInputRef = (el: HTMLInputElement | null) => {
      localInputRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    };

    return (
      <span className="chat-skill-chip" contentEditable={false}>
        <span
          className="chat-skill-chip__label"
          // §7: clicking the pill label focuses the arg input, caret at end
          // — the label itself is never a caret position.
          onMouseDown={(e) => {
            e.preventDefault();
            const el = localInputRef.current;
            if (!el) return;
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          }}
        >
          /{prefix.name}
        </span>
        <input
          ref={setInputRef}
          type="text"
          // §7: chips are not tab stops — reachable only via the editor's
          // own arrow/backspace/click handling, never plain Tab.
          tabIndex={-1}
          className="chat-skill-chip__arg-input"
          style={{ width: `${argInputWidthCh}ch` }}
          value={prefix.args}
          placeholder={argumentHint}
          aria-label={`Arguments for ${prefix.name}`}
          onChange={(e) => {
            onArgsChange(sanitizeArgs(e.target.value));
          }}
          onPaste={(e) => {
            // `<input type="text">` silently strips \n/\r from a plain value
            // assignment, so by the time `onChange` sees it a pasted newline
            // is already gone — but browsers CONCATENATE the lines with no
            // separator, which would still corrupt the args (e.g.
            // "high\n--fix" -> "high--fix"). Read the clipboard directly and
            // splice in the sanitized text ourselves (a single space in
            // place of each newline) before the browser's own strip-and-glue
            // behavior can run.
            const pasted = e.clipboardData.getData("text");
            if (!/\r?\n/.test(pasted)) return; // no newline — let the default paste happen
            e.preventDefault();
            const input = e.currentTarget;
            const start = input.selectionStart ?? input.value.length;
            const end = input.selectionEnd ?? input.value.length;
            const sanitized = sanitizeArgs(pasted);
            const next = input.value.slice(0, start) + sanitized + input.value.slice(end);
            onArgsChange(next);
          }}
          onKeyDown={(e) => {
            // IME guard — first check in every key handler.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            // The editor (Lexical) must NEVER see keystrokes that land in
            // this nested native input — every branch below either handles
            // the key itself or falls through to the default `stopPropagation`
            // at the end, so a bare character never reaches the contenteditable
            // root as a stray command.
            e.stopPropagation();

            if (e.key === "Enter") {
              // Unconditional, at ALL three mount sites: never sends, saves,
              // or discards. Ctrl/Cmd+Enter is the one escape hatch,
              // delegated entirely to the parent via `onCtrlEnter`.
              e.preventDefault();
              if (e.ctrlKey || e.metaKey) {
                onCtrlEnter();
                return;
              }
              // Plain Enter EXITS the chip to the document, just after it,
              // from any caret position — a no-op here would strand the
              // caret in the arg field and prose gets appended to the args.
              onExitToProse();
              return;
            }
            if (e.key === "Escape") {
              // Spec §10: must not reach QueuedTurnEditor's discard-on-Escape
              // NOR a window-level listener (WorkspaceCanvas's tile-fullscreen
              // Escape) — React's synthetic `stopPropagation` only stops the
              // React tree, not a native window listener, so this needs
              // `stopImmediatePropagation` on the native event. Exits to
              // after-chip (spec §10), same destination as plain Enter.
              e.preventDefault();
              e.nativeEvent.stopImmediatePropagation();
              onExitToProse();
              return;
            }
            if (e.key === "Backspace") {
              const input = e.currentTarget;
              const isEmpty = input.value.length === 0;
              const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
              if (isEmpty) {
                // §2: in args, empty — remove chip, leave `/`.
                e.preventDefault();
                onCollapseToSlash();
                return;
              }
              if (atStart) {
                // §2: at start of a NON-EMPTY arg input — exit left without
                // deleting (never eats a character on the way out).
                e.preventDefault();
                onExitToProseBefore();
                return;
              }
              // Mid/end of non-empty args — let the native input delete one
              // character normally.
              return;
            }
            if (e.key === "Delete") {
              const input = e.currentTarget;
              const isEmpty = input.value.length === 0;
              const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
              if (isEmpty) {
                // §2: forward-Delete in an empty arg slot also collapses.
                e.preventDefault();
                onCollapseToSlash();
                return;
              }
              if (atEnd) {
                // §2: at end of non-empty args — exit right without deleting.
                e.preventDefault();
                onExitToProse();
                return;
              }
              // Mid/start of non-empty args — let the native input
              // forward-delete one character normally.
              return;
            }
            if (e.key === "ArrowRight") {
              const input = e.currentTarget;
              const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
              if (atEnd) {
                e.preventDefault();
                onExitToProse();
                return;
              }
            }
            if (e.key === "ArrowLeft") {
              const input = e.currentTarget;
              const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
              if (atStart) {
                e.preventDefault();
                onExitToProseBefore();
                return;
              }
            }
          }}
        />
      </span>
    );
  },
);
