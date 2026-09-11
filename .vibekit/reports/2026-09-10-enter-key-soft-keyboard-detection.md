<!--
RULES — read before writing this report:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. ANSWER FIRST: the finding goes at the top, before any evidence
3. EVERY CLAIM CITED: file:line, a command + its output, or a screenshot
4. READING TIME: optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Report: Enter-as-newline should key off "soft keyboard showing", not touch capability

**Date:** 2026-09-10 · **Commit:** 00a3338 · **Scope:** `web-ui/src/components/chat/SkillEditor.tsx` + its 6 mount sites · **Method:** code inspection (grep + read)

## Answer
- Yes, the change makes sense: the current `navigator.maxTouchPoints > 0` check is a **hardware capability**, not a **current input mode** — a phone in split-screen, an external-keyboard iPad, or a laptop with a touchscreen all have `maxTouchPoints > 0` yet a physical keyboard is present, so plain-Enter silently inserts a newline instead of sending.
- The entire fix is **one function** in `SkillEditor.tsx` — every prompt field (Rich Chat composer, queued-turn editor, and all 4 agent dialogs) renders the **same** `<SkillEditor>`, so the `KEY_ENTER_COMMAND` handler at `SkillEditor.tsx:472-494` is the single site that needs changing.
- Do it via the **VirtualKeyboard API** (`navigator.virtualKeyboard.overlayContentRect.height > 0`) where supported (Chromium 94+), falling back to a coarse-heuristic when absent — this is "keyboard currently showing", not "device has touch".

## Evidence
| Claim | Source |
|-------|--------|
| Enter/newline decision lives in one `KEY_ENTER_COMMAND` handler | `web-ui/src/components/chat/SkillEditor.tsx:472-494` |
| Current check is touch *capability*: `navigator.maxTouchPoints > 0` | `web-ui/src/components/chat/SkillEditor.tsx:480` |
| Rich Chat composer mounts `<SkillEditor>` | `web-ui/src/components/chat/Composer.tsx:147` |
| Queued-turn editor mounts `<SkillEditor>` | `web-ui/src/components/chat/QueuedTurnEditor.tsx:117` |
| NewAgentDialog mounts `<SkillEditor>` | `web-ui/src/components/dialogs/NewAgentDialog.tsx:1550` |
| NewAgentTabDialog mounts `<SkillEditor>` | `web-ui/src/components/dialogs/NewAgentTabDialog.tsx:156` |
| NewAgentSessionDialog mounts `<SkillEditor>` | `web-ui/src/components/dialogs/NewAgentSessionDialog.tsx:348` |
| NewAgentDirectDialog mounts `<SkillEditor>` | `web-ui/src/components/dialogs/NewAgentDirectDialog.tsx:199` |
| Existing tests cover the key table at the Composer mount site | `web-ui/src/components/chat/SkillEditor.test.tsx:273-317` |

## Detail

### Current behaviour
- `KEY_ENTER_COMMAND` handler logic (`SkillEditor.tsx:480-488`):
  - `isTouchDevice = navigator.maxTouchPoints > 0`
  - `isModifiedEnter = ctrlKey || metaKey`
  - `isNewlineCombo = shiftKey || altKey`
  - newline iff `isNewlineCombo || (isTouchDevice && !isModifiedEnter)`
- Net effect on any touch-capable machine: **plain Enter = newline; Ctrl/Cmd+Enter = send** (the `onSubmitRef.current()` call at `SkillEditor.tsx:490`).
- `maxTouchPoints` is fixed per-device, read once per keydown, never changes → the decision can't track "is the soft keyboard up right now".

### Why "touch capable" is the wrong predicate
| Scenario | `maxTouchPoints > 0` | Physical kb present | Desired plain-Enter |
|----------|:---------------------:|:-------------------:|:-------------------:|
| Phone, on-screen kb | yes | no | newline |
| Phone + Bluetooth/hardware kb | yes | yes | send |
| Tablet + external keyboard | yes | yes | send |
| Touchscreen laptop, hardware kb | yes | yes | send |
| Desktop (no touch) | no | yes | send |

### Option A — VirtualKeyboard API (recommended)
- `navigator.virtualKeyboard` exposes `overlayContentRect` whose `.height > 0` while the on-screen keyboard is showing; fires a `virtualkeyboardchange` event on show/hide. Chromium 94+, incl. Android; not in Firefox/Safari.
- Exactly the "currently showing" signal requested — no re-measure, event-driven.
- In `KEY_ENTER_COMMAND`: replace `isTouchDevice` with `isSoftKeyboardVisible()`.
- Also enables a `visualViewport`-independent sentinel; no layout heuristics needed when present.

### Option B — coarse media query fallback
- `matchMedia("(any-hover: none)")` / `(any-pointer: coarse)` — still **capability**, not current state; only a fallback. Same "hardware present" flaw as today, so not a true fix on its own.

### Option C — viewport delta heuristic (last resort)
- Compare `visualViewport.height` vs `window.innerHeight` while the field is focused; on-screen kb shrinks the visual viewport. Heuristic, browser-dependent, not event-driven — fragile; only useful where VirtualKeyboard API is unavailable and media queries are unhelpful.

### Recommended composition
```
isSoftKeyboardVisible():
  if navigator.virtualKeyboard exists → return virtualKeyboard.overlayContentRect.height > 0
  else → fall back to (any-hover:none) [capability] or visualViewport delta heuristic
```
- Cache the VirtualKeyboard decision on `virtualkeyboardchange`, don't re-read every keydown.
- Keep `isModifiedEnter` (Ctrl/Cmd+Enter always sends) and `isNewlineCombo` (Shift/Alt+Enter always newline) unchanged — they are modifier intent, orthogonal to the device question.
- Update the hint copy in `Composer.tsx:220-224` (currently advertises "Enter sends" unconditionally) to match the runtime decision.

### Test strategy
- `SkillEditor.test.tsx:273-317` is the key-table suite — add cases:
  - virtual keyboard "hidden" (`overlayContentRect.height = 0`) + touch-capable navigator → plain Enter **sends**
  - virtual keyboard "showing" (`height > 0`) → plain Enter **newline**
  - VirtualKeyboard API absent → fallback branch exercised
- jsdom must stub `navigator.virtualKeyboard` (not present by default) — mock in the test setup, mirroring how `maxTouchPoints` is currently assumed.

## Not checked
- Safari/iOS: VirtualKeyboard API unsupported there; the fallback path's exact behaviour on iOS Safari (which uses a different, historically buggy virtual-keyboard model) is unverified — needs a device check, not just code.
- Whether the daemon/terminal channel has the same Enter-vs-newline concern (this report covers only the `<SkillEditor>` prompt surfaces).

## Follow-ups
| # | Question | Why it matters |
|---|----------|-----------------|
| 1 | Confirm target browser support for `navigator.virtualKeyboard` (Tauri webview = Chromium?) | Determines whether the API path or the heuristic fallback is the primary on the desktop app |
| 2 | Verify iOS Safari fallback on a real device | The API is absent there; the fallback must not regress plain-Enter-sends |
| 3 | Should the hint line be dynamic? | `Composer.tsx:220-224` advertises "Enter sends" statically, which is wrong when a soft keyboard forces newline |
