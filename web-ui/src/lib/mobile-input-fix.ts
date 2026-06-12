/**
 * Mobile soft-keyboard input fix (double-text-fix-2).
 *
 * ── Why xterm has the code we're working around (do NOT "simplify" it away) ──
 * Browsers fire keydown with `keyCode === 229` whenever a keystroke is being
 * produced by an input method rather than a directly-identifiable physical key.
 * xterm can't know the character at keydown time in that case, so it falls back
 * to `CompositionHelper._handleAnyTextareaChanges`: let the input method type
 * into the hidden helper textarea, then diff the textarea's before/after value
 * to recover what was entered. That 229 path is NOT dead code and is NOT
 * mobile-only plumbing you can delete — it is what makes IME composition (CJK),
 * dictation/voice input, and predictive text work. It just happens to be buggy
 * for the plain-typing sub-case that mobile soft keyboards exercise.
 *
 * ── The bug (confirmed from on-device logs + xterm@6.0.0 source) ──
 * On Android/Gboard, every plain keypress arrives as keyCode 229 with NO
 * composition events. xterm never clears the textarea on this path and extracts
 * the new char via `newValue.replace(oldValue, "")` — a *substring* replace
 * that assumes oldValue is a clean prefix of newValue. The textarea accumulates,
 * the caret drifts so chars land non-contiguously, the replace finds no match
 * and returns the ENTIRE value, and xterm re-sends the whole accumulated buffer
 * on a single keypress (the "prompt replay" bug).
 *
 * ── The fix ──
 * Intercept `beforeinput` on the helper textarea. For non-composing
 * insert/delete we preventDefault (so the textarea can't accumulate and xterm's
 * broken diff sends nothing) and forward the reliable single `event.data`
 * ourselves. Composition (CJK/IME) and paste are left to fall through to xterm
 * untouched — that is why we bail on `isComposing` and `insertCompositionText`
 * rather than patching or removing xterm's 229 handler.
 *
 * Desktop is unaffected: xterm cancels printable keys in keydown, so beforeinput
 * never fires for them there and this interceptor stays dormant.
 */

export function attachMobileInputFix(
  textarea: HTMLTextAreaElement,
  send: (data: string) => void,
  // Optional diagnostic hook (mobile double-text investigation): records what
  // the fix decided for each beforeinput. Off in normal operation.
  log?: (entry: Record<string, unknown>) => void,
): () => void {
  let composing = false;

  const onCompositionStart = () => {
    composing = true;
  };
  const onCompositionEnd = () => {
    composing = false;
  };

  const onBeforeInput = (e: InputEvent) => {
    // Let the IME drive composition (CJK, emoji pickers, dead keys/accents).
    if (composing || e.isComposing) {
      log?.({ kind: "fix", inputType: e.inputType, decision: "skip-composing", composing, isComposing: e.isComposing });
      return;
    }

    let handled = true;
    let out: string | null = null;
    // "insertText" is a normal key. "insertReplacementText" is a glide-typed
    // word or an autocorrect/suggestion swap — we can only forward the new word
    // (e.data) since the hidden textarea is kept empty so there's no range to
    // diff, but that still beats xterm replaying the whole buffer.
    switch (e.inputType) {
      case "insertText":
      case "insertReplacementText":
        out = e.data;
        break;
      case "insertLineBreak":
      case "insertParagraph":
        out = "\r";
        break;
      case "deleteContentBackward":
        out = "\x7f"; // DEL / backspace
        break;
      case "deleteContentForward":
        out = "\x1b[3~"; // forward-delete
        break;
      case "deleteWordBackward":
        out = "\x17"; // Ctrl-W
        break;
      case "deleteWordForward":
        out = "\x1bd"; // Meta-d
        break;
      default:
        // insertFromPaste (xterm's paste handler covers it), undo/redo, etc. —
        // leave to xterm rather than guessing.
        handled = false;
    }
    if (!handled) {
      log?.({ kind: "fix", inputType: e.inputType, decision: "passthrough" });
      return;
    }

    // We own this event: cancel it so xterm's keyCode-229 textarea diff can
    // neither accumulate nor re-send. `out` may be null/"" (e.g. insertText with
    // no data) — still cancel to starve the textarea, and just send nothing.
    e.preventDefault();
    log?.({ kind: "fix", inputType: e.inputType, decision: "send", out, outLen: out ? out.length : 0 });
    if (out) send(out);
  };

  textarea.addEventListener("compositionstart", onCompositionStart);
  textarea.addEventListener("compositionend", onCompositionEnd);
  textarea.addEventListener("beforeinput", onBeforeInput as EventListener);

  return () => {
    textarea.removeEventListener("compositionstart", onCompositionStart);
    textarea.removeEventListener("compositionend", onCompositionEnd);
    textarea.removeEventListener("beforeinput", onBeforeInput as EventListener);
  };
}
