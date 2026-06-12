# Mini-Design: Mobile soft-keyboard "prompt-buffer replay" fix

> One keypress on a mobile soft-keyboard randomly re-sent the **entire prompt typed so far** to the agent (e.g. `hello wor` + tap `l` → `hello worhello worl`). Desktop unaffected.

**Issue:** double-text-fix-2
**Branch:** `double-text-fix-2`
**Status:** Done — root-caused from on-device logs, fix confirmed on the reporter's phone.

**Key files:**
- Fix: `web-ui/src/lib/mobile-input-fix.ts` (new)
- Wiring: `web-ui/src/components/layout/TerminalPane.tsx`

---

## Problem

- Mobile only: a single keypress occasionally replayed the whole accumulated buffer to the agent. Random, recurrent.
- A prior attempt (reconnect double-attach guard) was unrelated and did not fix it.

## Root cause (confirmed)

- Captured the reporter's keystrokes via a temporary on-device logger + read xterm@6.0.0 source.
- On Android/Gboard, every plain keypress arrives as `keydown keyCode 229` ("Unidentified") with **no composition events**.
- xterm routes 229 keys through `CompositionHelper._handleAnyTextareaChanges`, which:
  - never clears its hidden helper textarea on this path → the textarea **accumulates** the typed buffer, and
  - recovers the new char via `newValue.replace(oldValue, "")` — a **substring** replace that assumes `oldValue` is a clean prefix.
- Once the textarea accumulates and the caret drifts so a char lands non-contiguously, `.replace` finds no match and returns the **entire** value → xterm re-sends the whole buffer on one keypress.
- Why mobile-only: desktop physical keys produce real keydown events that xterm handles directly (textarea path never entered).
- The 229 path is **not** dead code — it is also what makes IME composition (CJK), dictation, and predictive text work, so it must not be removed.

## Fix

- `attachMobileInputFix` intercepts `beforeinput` on the helper textarea:
  - For non-composing `insertText` / line-break / delete: `preventDefault()` (so the textarea can't accumulate and xterm's broken diff sends nothing) and forward the reliable single `event.data` ourselves.
  - Composition (`isComposing` / `insertCompositionText`) and paste fall through to xterm untouched.
- Desktop unaffected: xterm cancels printable keys in keydown, so `beforeinput` never fires for them and the interceptor stays dormant.
- Gated: disable with `localStorage.terminalInputFix = "0"`.

## Verification

- On-device log after the fix: every `beforeinput` shows `value:""` (textarea no longer accumulates); each keypress forwards exactly one char; daemon `session:input` `dataLen` is 1. No replay.
- Typecheck (`tsc -b --noEmit`) passes.

## Notes

- Diagnosis used a temporary harness (server-side input log + client→WS event shipping + dev-container Claude mount). All of it was reverted; only the fix and a `dev.Dockerfile` build-tools addition (python3/make/g++, needed to compile node-pty) remain.
