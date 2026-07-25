# JSON Agent Chat — UI Changes (one-pager)

> Companion to `json-agent-chat.md`. Every UI change, where it lives, and an ASCII mockup. 100gb tokens (`web-ui/src/styles/tokens.css`).

## Change table

| # | UI change | Where (file) | What changes | New? |
|---|-----------|--------------|--------------|------|
| 1 | Channel toggle | `dialogs/NewAgentDialog.tsx`, `DirectAgentDialog.tsx`, `NewTabDialog.tsx` | Terminal vs JSON-chat radio on agent create (worktree main, direct, additional `a{n}`) | mod |
| 1b | Create-dialog attachments | `dialogs/NewAgentDialog.tsx`, `DirectAgentDialog.tsx`, `NewTabDialog.tsx` + new `chat/AttachmentPicker.tsx` | Attachment row shown only when `channel="json"`: stage `File[]` pre-session; on submit create idle (no prompt in body → no daemon auto-enqueue), upload, then `POST /chat` prompt+attachmentIds as turn 1. Reuses `AttachmentChip`. | NEW |
| 2 | Session tab icon | `layout/*Tabs` | ⌨ terminal vs 💬 chat marker | mod |
| 3 | ChatPane shell | `layout/ChatPane.tsx` | Shown **beside** a permanently-mounted `TerminalPane` (visibility toggle, not swap — Dec 14) when `channel=json` | NEW |
| 4 | Message list | `chat/MessageList.tsx` | Scrollable transcript of normalized events | NEW |
| 5 | User bubble | `chat/TextMessage.tsx` | Right-aligned user message | NEW |
| 6 | Assistant bubble | `chat/TextMessage.tsx` + reuse `preview/MarkdownView.tsx` | Markdown answer (GFM), streaming-tolerant | NEW |
| 7 | Thinking block | `chat/ThinkingBlock.tsx` | Collapsible dim reasoning | NEW |
| 8 | Tool-use card | `chat/ToolUseCard.tsx` | Tool name + input + running spinner | NEW |
| 9 | Tool-result card | `chat/ToolResultCard.tsx` | Collapsible output; diff view for edits | NEW |
| 10 | Error card | `chat/ErrorCard.tsx` | Turn error + Retry | NEW |
| 11 | Code block | reuse `preview/CodeBlock.tsx` | Syntax highlight + copy (already exists) | reuse |
| 11b | Markdown | reuse `preview/MarkdownView.tsx` | GFM render (already exists) | reuse |
| 12 | Diff view | reuse `preview/DiffView.tsx` | +/− line styling (already exists) | reuse |
| 13 | Mermaid block | reuse `preview/MermaidView.tsx` | Sandboxed SVG, already `securityLevel:"strict"` (flagged) | reuse (flag) |
| 14 | Composer | `chat/Composer.tsx` | Textarea + send + stop | NEW |
| 15 | Attachment chips | `chat/AttachmentChip.tsx` | Drop/picker uploads, name·size·remove | NEW |
| 16 | Status bar | `chat/StatusBar.tsx` | Tokens/context % · model · mode · turn-state | NEW |
| 17 | Queued indicator | `chat/MessageList.tsx` / `StatusBar` | Pending bubble + "Queued (n)" | NEW |
| 18 | Empty state | `chat/ChatPane.tsx` | "Start chatting" before first turn | NEW |
| 19 | Replay/loading | `chat/ChatPane.tsx` | "Loading history…" on `chat:open` | NEW |
| 20 | Pane selection | `routes/Workspace.tsx` | Keep `TerminalPane` mounted (`sessionId=null` for JSON); toggle `ChatPane` visibility beside it — no if/else remount (Dec 14) | mod |

---

## ASCII mockups

**1 / 1b — Create dialog: channel toggle + attachment row (JSON only)**
```
┌ New Session ───────────────────────────┐
│ Mode     [ Claude        ▾ ]            │
│ Model    [ (default)     ▾ ]            │
│ Prompt   [____________________]         │
│ Channel  ( ) Terminal  (•) JSON         │  ← 1
│ Attach   ┌───────────────────────────┐  │  ← 1b (only when JSON)
│  (opt.)  │ [📎 log.txt ✕]            │  │     staged File[] chips (AttachmentChip)
│          │ [📎 Attach files] or drop │  │     picker + dropzone
│          └───────────────────────────┘  │
│                    [ Cancel ] [ Create ]│
└──────────────────────────────────────────┘
```
> On Create (JSON): create the session/worktree WITHOUT the prompt in the body
> (so the daemon does not auto-enqueue turn 1), then `uploadAttachments(sessionId,
> files)` and `sendChat(sessionId, prompt, attachmentIds)` as turn 1. Terminal
> path is unchanged (prompt stays in the create body). No double turn-1.

**2 / 3 / 20 — Tabs + ChatPane shell (shown beside a mounted-but-hidden TerminalPane)**
```
[ ● main 💬 ][ a1 ⌨ ][ + ]                 ← 💬 chat vs ⌨ terminal
┌─────────────────────────────────────────┐
│  MessageList  (scroll)                    │  (4)
│                                           │
│                                           │
├───────────────────────────────────────────┤
│ 12k/200k (6%) · opus · Plan   ⟳ Responding│  StatusBar (16)
│ [📎 log.txt ✕]                            │  chips (15)
│ ┌───────────────────────────────────────┐ │
│ │ Type a message…                  [ ▶ ]│ │  Composer (14)
│ └───────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

**5–10 — Message kinds**
```
                         ┌────────────────┐
                  user ▶ │ fix the bug     │   (5) user bubble
                         └────────────────┘
┌ assistant ───────────────────────────────┐  (6) markdown bubble
│ Here's the fix:                            │
│ ```ts                              [copy]  │  (11) code block
│   const x = 1                              │
│ ```                                        │
└────────────────────────────────────────────┘
▸ Thinking…                                     (7) collapsed
┌ 🔧 Bash  `ls -la`                 [running] ┐  (8) tool_use
└────────────────────────────────────────────┘
┌ ✓ Bash result                          [▾] ┐  (9) tool_result (collapsible)
│ total 24                                    │
└────────────────────────────────────────────┘
┌ ⚠ Error                                     ┐  (10) error card
│ harness exited 1                  [ Retry ] │
└────────────────────────────────────────────┘
```

**12 / 13 — Diff + mermaid**
```
┌ ✎ Edit  app.ts                         [▾] ┐   (12) diff view
│  context line                               │
│ -  const a = 1                              │   red
│ +  const a = 2                              │   green
└────────────────────────────────────────────┘
┌ mermaid (flag on) ──────────────────────────┐  (13)
│  [ rendered SVG ]   ·  flag off → ```mermaid │
└────────────────────────────────────────────┘
```

**14 / 15 / 16 — Composer + chips + status**
```
┌──────────────────────────────────────────────┐
│ 12,304 / 200,000 tok (6%) · opus · Plan        │  (16) usage·model·mode
│ ⟳ Responding…                          [ Stop ]│  (16) turn-state + stop
├──────────────────────────────────────────────┤
│ [📎 diagram.png ✕] [📎 log.txt ✕]              │  (15) attachment chips
│ ┌──────────────────────────────────────────┐  │
│ │ Type a message…                          │  │  (14) textarea
│ └──────────────────────────────────────────┘  │
│  ⤓ drop files here                      [ ▶ ]  │  (15) dropzone + send
└──────────────────────────────────────────────┘
```

**17 — Queued (send while busy)**
```
                ┌──────────────┐
         user ▶ │ add a test    │  (queued · 1) ⏳   greyed pending
                └──────────────┘
status: ⟳ Responding…   |   Queued: 1
```

**18 / 19 — Empty + replay states**
```
   empty (new chat)            replay (reconnect/reload)
┌──────────────────┐        ┌──────────────────────────┐
│       💬          │       │  ⟳ Loading history…       │
│  Start chatting   │       │                           │
│  with the agent   │       │                           │
└──────────────────┘        └──────────────────────────┘
```

---

## Turn-state → status indicator

| `turnState` | Indicator |
|-------------|-----------|
| `idle` | `Ready` |
| `queued` | `Queued (n)` + pending bubble |
| `thinking` | `⟳ Thinking…` |
| `responding` | `⟳ Responding…` |
| `tool` | `⟳ Running <tool>…` |
| `error` | `⚠ Error` + Retry |

> Reused from `json-agent-chat.md` Event Normalization; this is the only place it's drawn.
