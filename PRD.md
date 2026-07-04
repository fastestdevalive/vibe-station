# PRD — Agentic IDE Workspace

Status: Draft · Owner: @beebom786 · Branch: `revisit-layout`

## 1. Why

vibe-station is becoming an agentic IDE, not just a terminal multiplexer. The
agent needs first-class surfaces to *show* its work — a live website, an Android
device/emulator screen, captured screenshots and other artifacts — and the user
needs to feed files **into** the agent's environment without manually `scp`-ing
them to the server. The current layout (a single shared pane for the main agent
plus ad-hoc terminals, a file tree, and a file preview) can't host any of that.

## 2. Goals

- Give the right side of the workspace a home for **multiple tools**: file
  preview, an in-app **browser**, an **emulator/device** screen, and an
  **artifacts** view.
- **Separate terminals from agent sessions** so the agent chat is no longer
  cluttered by shell tabs.
- Let the agent (and user) **open files and artifacts**, **upload files/folders**
  into the worktree/artifacts area, and **drive the browser** (load, refresh,
  navigate).

### Non-goals (for now)
- Real browser embedding, emulator streaming, and artifact storage backends —
  these are *follow-up* milestones. This worktree only makes the layout ready.
- Multi-window / pop-out tools.

## 3. Users & key flows

1. **See the app run** — agent starts a dev server → user opens the Browser tool,
   enters/loads the URL, refreshes, navigates.
2. **See the device** — agent connects an emulator/device → user opens the
   Emulator tool and watches the live screen.
3. **Review artifacts** — agent captures screenshots/logs/files that aren't part
   of the worktree → user opens the Artifacts tool to browse/preview/download.
4. **Upload inputs** — user drops a file/folder into Artifacts (or the worktree)
   so the agent can use it, instead of moving it onto the server by hand.
5. **Work the shell** — terminals live in their own dock, independent of which
   agent tab is focused.

## 4. Layout

```
┌───────────────────────────────────────────────────────────┐
│ TopBar:  brand · crumb · [tool panel] [terminal dock]      │
├──────┬───────────────────────────────┬────────────────────┤
│ Nav  │ Agent pane                    │ Tool panel          │
│ rail │  ┌ agent tabs: main a1 a2 + ┐ │ [Files][Preview]    │
│      │  │                          │ │ [Browser][Emulator] │
│      │  │   agent CLI (xterm)      │ │ [Artifacts]         │
│      │  └──────────────────────────┘ │  (active tool body) │
│      ├───────────────────────────────┴────────────────────┤
│      │ Terminal dock:  term t1 t2 +        ⤢               │
│      │  $ _                                                │
└──────┴────────────────────────────────────────────────────┘
```

- **Agent pane** (center): agent sessions only (`m`, `a*`). Always present.
- **Tool panel** (right): one collapsible, resizable panel with tabs —
  **Files · Devices · Artifacts**. One tool visible at a time; switch via tabs.
  Fullscreen supported.
- **Terminal dock** (bottom): collapsible, resizable panel hosting terminal
  sessions (`t*`) with their own tab strip and named tabs. Independent of the
  agent pane.
- **Nav rail** (left): projects / worktrees (unchanged).

## 5. Tool surfaces (placeholders this milestone)

| Tab | This milestone | Later |
|-----|----------------|-------|
| Files | Master-detail: file tree (left) + preview (code/markdown/diff, right) | open-file from agent |
| Devices | Sub-tabs (Web + emulators/devices); Web has a disabled URL bar, device entries are placeholders | embedded webview the agent drives (load/refresh/navigate) + live emulator/device screen stream; sub-tabs from connected devices |
| Artifacts | Master-detail: list (icon, name, size, time, source) + in-place detail; disabled Download/Copy-path/Delete + Upload file/folder | list/preview/download real artifacts; tap → image lightbox / text viewer; working upload |

### 5a. Files
**Master-detail.** The file tree (navigation) on the left and the preview
(code/markdown/diff) on the right, in one tab — so browsing and reading happen
together with no tab flip. Mirrors the Artifacts list/detail pattern. Selecting
a file (tree, ⌘P quick-open, or changed-file list) shows it in the preview
without leaving the tab.

### 5b. Devices
One **Devices** tab combines the web browser and connected emulators/physical
devices as **sub-tabs** (`Web`, `Pixel 7`, …), one live view at a time, with a
`+` to connect a device. "Web" is always present; device sub-tabs come from the
server once streaming lands.

### 5c. Artifacts
**Master-detail.** Left: a list of artifacts (newest first) — type icon (image
thumbnail for screenshots), name, size, timestamp, producing session/agent.
**Tapping a row opens it in-place on the right** — image lightbox for
screenshots, text/log viewer otherwise — with **Download · Copy path · Delete**.
A top bar offers **Upload file / Upload folder** so inputs can be added without
moving them onto the server by hand.

### 5d. Terminals
Terminals carry a **name** shown on the dock tab. The **New Terminal** dialog
prefills an editable default; agent and terminal creation are **separate
dialogs** (no type toggle).

**Daemon model.** `SessionRecord.name?: string` (mutable — a rename endpoint can
update it later). `WorktreeRecord.terminalSeq?: number` is a **monotonic**
per-worktree counter — never reused, so default names stay unambiguous across a
worktree's life. On terminal create a custom `name` wins, else the daemon
assigns `Terminal {seq}` and bumps `terminalSeq`; the serialized `label` is the
`name` when set, else slot-derived. `GET /worktrees/:id/next-terminal-name`
returns the next default so the dialog can prefill it. Slot identity (`t{n}`) is
unchanged — `name` is display-only.

### 5e. Initial context (creation-time artifacts)
The **New worktree** and **New agent** dialogs include an optional **Initial
context** dropzone — attach images/files (specs, screenshots, sample data) so
the agent starts with more context. On submit, the files are copied into the
worktree's **artifacts** directory and referenced in the agent's launch prompt
(e.g. an "attached context" section listing the artifact paths). Terminals don't
get this (no agent to brief). UI is a disabled placeholder for now.

Open questions: when do files upload — before worktree creation (staged, then
moved once the worktree dir exists) or after? How are they referenced in the
prompt (inline paths vs. a manifest the agent can read)? Size/type limits?

## 6. Agent capabilities (future milestones, layout must accommodate)

- `open file <path>` → selects Files/Preview tab on a file.
- `open artifact <id>` → selects Artifacts tab on the item (e.g. a screenshot).
- `upload artifact` → user-initiated upload of a file/folder into the
  artifacts/worktree area.
- **initial context on create** → attach files in the New worktree / New agent
  dialog; copied to the artifacts dir and surfaced in the launch prompt.
- `browser.load(url)` / `refresh()` / `navigate()` → drives the Browser tool.
- `emulator.stream(deviceId)` → renders a connected device in the Emulator tool.

## 7. Scope of THIS worktree (`revisit-layout`)

In: layout foundation only.
- Refactor the workspace into three named regions: **agent pane**, **tool
  panel**, **terminal dock**.
- **Terminals separated from agents** — each has its own tab strip and active
  session; both can stream concurrently.
- Tool panel with **Files/Preview/Browser/Emulator/Artifacts** tabs; Browser,
  Emulator, Artifacts are wired **placeholder** components.
- Persisted per-worktree layout state for the new regions.

Out: browser/emulator/artifacts backends, upload pipeline, agent control APIs.

## 8. Open questions

- Should artifacts live per-worktree or per-project? (assume per-worktree)
- Emulator transport: WebRTC vs MJPEG/scrcpy-over-ws? (decide in emulator
  milestone)
- Browser: real embedded webview vs proxied iframe (CORS/X-Frame-Options)?
- Should terminals optionally re-dock to the right panel as a tab? (deferred;
  current decision is a dedicated bottom dock)
