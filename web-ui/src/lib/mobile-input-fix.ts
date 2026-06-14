/**
 * Mobile soft-keyboard input fix — gated to the Android/IME keyCode-229 path.
 *
 * ── The bug (confirmed from on-device input-debug logs) ──
 * On Android/Gboard, keys arrive as `keydown` with `keyCode === 229`
 * ("Unidentified"). xterm routes those through `_handleAnyTextareaChanges`,
 * which NEVER clears its hidden helper textarea, so the textarea accumulates
 * the entire message. xterm then recovers each new keystroke with
 * `newValue.replace(oldValue, "")` — a *substring* replace. When an edit is not
 * a clean append (a delete + insert, or a char landing mid-string because the
 * accumulated buffer's cursor drifted), `oldValue` is no longer a contiguous
 * substring of `newValue`, so `.replace` returns the WHOLE value → the entire
 * buffer is re-sent on one keypress (the "reprint"). The same accumulation also
 * lets Gboard's autocorrect mangle the growing buffer (character doubling).
 *
 * ── The fix ──
 * Intercept `beforeinput` on the helper textarea and, for the Android path,
 * forward the single character ourselves and `preventDefault()` so the textarea
 * can never accumulate (and xterm's broken diff therefore sends nothing). We
 * handle insert AND delete explicitly, because on this path backspace arrives
 * as `deleteContentBackward` (not a real Backspace key), and a naive
 * "clear the textarea" approach would silently break it.
 *
 * ── Why this is desktop-safe (the critical gate) ──
 * A previous, UNGATED version of this interceptor double-sent space and capital
 * letters on desktop: those keys fire `beforeinput` AND go through xterm's
 * keydown/keypress path, so both sent the char. The fix is the `keyCode === 229`
 * gate below: desktop physical keys have real keyCodes, so they never match and
 * fall straight through to xterm untouched. CJK/IME composition is also left to
 * xterm (we bail on `isComposing`). The interceptor only ever acts on the
 * Android soft-keyboard path.
 *
 * Failure mode is a *miss*, never a regression: if the gate ever fails to fire
 * (e.g. a stale keyCode), the event simply falls through to xterm's existing
 * behavior — no double-send is possible.
 */

export function attachMobileInputFix(
  textarea: HTMLTextAreaElement,
  send: (data: string) => void,
): () => void {
  let composing = false;
  // keyCode of the most recent keydown. 229 == the browser's "input method is
  // producing this key" sentinel, which is what Android soft keyboards emit.
  let lastKeyCode = -1;

  const onKeyDown = (e: Event) => {
    lastKeyCode = (e as KeyboardEvent).keyCode;
  };
  const onCompositionStart = () => {
    composing = true;
  };
  const onCompositionEnd = () => {
    composing = false;
    // Consume the composition's trailing keyCode-229. Otherwise a later
    // autocorrect / suggestion-tap `beforeinput` (which has no fresh keydown)
    // would still see lastKeyCode===229 and pass the gate on desktop-with-IME.
    // The Android path re-arms on its very next keydown, so this is free there.
    lastKeyCode = -1;
  };

  const onBeforeInput = (e: InputEvent) => {
    // GATE: only act on the Android/IME path. Desktop physical keys have real
    // keyCodes and MUST fall through to xterm (otherwise we double-send).
    if (lastKeyCode !== 229) return;
    // Let the IME drive composition (CJK, emoji pickers, dead keys/accents).
    if (composing || e.isComposing) return;

    let handled = true;
    let out: string | null = null;
    switch (e.inputType) {
      // insertText is a normal char; insertReplacementText is a glide-typed word
      // or an autocorrect/suggestion swap. Both just forward the new text. Note:
      // on an autocorrect swap the originally-typed chars were already sent
      // keystroke-by-keystroke — we forward the replacement but do NOT retract
      // them (autocorrect is disabled on the helper textarea, so this is rare).
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
        // insertFromPaste etc. — leave to xterm rather than guessing.
        handled = false;
    }
    if (!handled) return;

    // We own this event: cancel it so the textarea can't accumulate and xterm's
    // keyCode-229 diff sends nothing. `out` may be null/"" (insertText with no
    // data) — still cancel to starve the textarea, and send nothing.
    e.preventDefault();
    if (out) send(out);
    // Consume the 229: each subsequent input must be authorized by its own
    // keydown. Closes the "beforeinput with no preceding keydown" hole (desktop
    // autocorrect/suggestion taps) while leaving the Android path — which fires
    // a fresh keydown===229 before every char — fully intact.
    lastKeyCode = -1;
  };

  textarea.addEventListener("keydown", onKeyDown, true);
  textarea.addEventListener("compositionstart", onCompositionStart);
  textarea.addEventListener("compositionend", onCompositionEnd);
  textarea.addEventListener("beforeinput", onBeforeInput as EventListener);

  return () => {
    textarea.removeEventListener("keydown", onKeyDown, true);
    textarea.removeEventListener("compositionstart", onCompositionStart);
    textarea.removeEventListener("compositionend", onCompositionEnd);
    textarea.removeEventListener("beforeinput", onBeforeInput as EventListener);
  };
}
