# JSON Agent Chat — UI Screenshots

> Captured from the **real** React components (mock-data driven, 100gb dark theme). Companion to `json-agent-chat.md` / `json-agent-chat-ui-changes.md`.
> Images live in `web-ui/screenshots-json-chat/`. Also available as a self-contained page: `json-agent-chat-screenshots.html`.

## Create dialog — JSON channel + attachments at creation
JSON channel selected, with two staged files ready to send as turn 1.

![Create agent dialog with JSON channel and staged attachments](../../web-ui/screenshots-json-chat/create-json.png)

## Create dialog — unsupported CLI (gemini) gated
JSON radio disabled with an inline hint; the daemon also rejects it (400).

![Create dialog with JSON disabled for gemini](../../web-ui/screenshots-json-chat/create-gemini.png)

## Tab strip — terminal vs chat markers
`⌨` marks a TTY agent, `💬` marks a JSON chat agent.

![Tab strip showing terminal and chat markers](../../web-ui/screenshots-json-chat/tabstrip.png)

## Full chat thread
User bubble (with attachment) → thinking block → assistant markdown + syntax-highlighted code (Copy) → tool-use card → tool-result **diff** → error card (Retry) → status bar + composer.

![Full JSON chat thread](../../web-ui/screenshots-json-chat/chat.png)

## Running tool state
Tool card with spinner; status bar "Running tool…" + Stop.

![Chat with a running tool](../../web-ui/screenshots-json-chat/chat-running.png)

## Queued turn (send while busy)
Dimmed pending bubble; status "Queued (1)".

![Queued turn indicator](../../web-ui/screenshots-json-chat/queued.png)

## Queue controls — Send now / Edit / inline editor
_New (queue-controls)._ **Top:** a queued user bubble carries **⏭ Send now** (jump the queue), **✎ Edit**, and **✕ Cancel** (revealed on hover). **Bottom:** clicking Edit withdraws the turn into an inline **editor** prefilled with its text + attachments — Save re-enqueues the edit at its original position, Discard restores it unchanged.

![Queue controls: send-now affordances and the inline editor](../../web-ui/screenshots-json-chat/queue-controls.png)

## Status bar states
Tokens · context % · cost · model · mode, across idle / responding / queued.

![Status bar variants](../../web-ui/screenshots-json-chat/statusbar.png)

## Attachments
Chips in uploading / error / ready states, the picker with staged files, and an attached file inside a sent message. _Updated:_ the chips **inside the sent (accent) user bubble** now use a translucent light overlay so the filename + size are readable — fixing the earlier dark-on-dark chip.

![Attachment states](../../web-ui/screenshots-json-chat/attachments.png)

## Empty state
Before the first turn.

![Empty chat state](../../web-ui/screenshots-json-chat/empty.png)

## Loading / replay state
While `chat:open` replays transcript history.

![Loading history state](../../web-ui/screenshots-json-chat/loading.png)
