<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# PRD: Markdown image rendering + fullscreen image/mermaid zoom

> Render repo images in Rich Chat, show image files as images in the file preview, and add mouse/touch zoom-pan fullscreen for markdown images and mermaid diagrams.

**Status:** Approved
**Technical plan:** `.vibekit/feature-plans/wip/image-rendering/plan-image-rendering.md`

---

## Problem

- Relative/root-relative repo image paths render broken (nothing) in Agent Rich Chat — `MarkdownView` gets no `api`/`worktreeId` there, so all non-remote `src` resolve to nothing (`MarkdownView.tsx:20-59`)
- Opening an image file (e.g. `.png`) in the file preview shows raw binary garbage via `CodeView` (`FilePreviewPane.tsx:319`)
- No way to zoom a markdown image or a mermaid diagram to inspect detail

## Goals

- Repo images render inline in both file-preview and Rich Chat, remote URLs keep working
- Image files open as actual images in the file preview, zoomable/pannable via mouse + touch
- Clicking a markdown image or a mermaid diagram opens a fullscreen zoom/pan overlay, shared across both contexts

## Non-goals

- Image editing, cropping, annotation
- Mermaid diagram editing/pan inside the inline (non-fullscreen) view
- Virtualized image lists, thumbnails
- Daemon-side changes — image fetching already works via `api.getFileBlob`

---

## Requirements

### 1. Rich Chat images

| ID | Requirement |
|----|-------------|
| R1 | Relative (`./x.png` / `x.png`) and root-relative (`/x.png`) image paths in assistant markdown render the repo file inline |
| R2 | Remote URLs (`http(s)://`, `//`, `data:`) still render as plain `<img>` in chat |
| R3 | Worktree sessions resolve repo images against the worktree; direct sessions resolve against the project scope |
| R4 | Missing/unfetchable image renders nothing (no broken-image flash) |

### 2. File preview images

| ID | Requirement |
|----|-------------|
| R5 | Opening a binary image file (png/jpg/gif/webp/svg) renders the actual image, not raw text |
| R6 | Preview supports mouse and touch zoom-in / zoom-out / pan |
| R7 | Double-click (or click affordance) opens the preview image in fullscreen zoom/pan |

### 3. Fullscreen zoom

| ID | Requirement |
|----|-------------|
| R8 | Clicking a markdown image opens a fullscreen overlay with mouse + touch zoom/pan |
| R9 | Clicking a mermaid diagram opens the same fullscreen overlay with mouse + touch zoom/pan |
| R10 | Escape / close button dismisses the overlay; body scroll is locked while open |
| R11 | Shared zoom/pan/fullscreen component reused across file-preview and chat — no duplicated zoom logic |

---

## Options considered

### Image-path resolution shared component

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A — Thread `api`/`worktreeId`/`scope` through chat into `MarkdownImage` | Reuses existing `getFileBlob`; no daemon change | New props threaded `ChatPane→MessageList→TextMessage→StreamingMarkdown→MarkdownView` | ✅ chosen |
| B — Global store lookup in chat | No prop threading | Hidden coupling; store may not have worktree for all chat instances | ❌ deferred |

### Image preview in FilePreviewPane

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A — Detect image by extension, fetch blob, render zoomable | Clean; reuses shared zoom component | Need extension→mime map | ✅ chosen |
| B — Let `CodeView` handle it | No work | Shows binary garbage | ❌ rejected |

---

## Resolved design questions

1. **Chat resolution scope?** — Worktree session → `worktree` scope; direct session (`worktreeId` null) → `project` scope. One prop pair `(worktreeId, scope)`.
2. **Which file extensions are images?** — png, jpg, jpeg, gif, webp, svg, bmp, avif.
3. **Fullscreen trigger for preview?** — a zoom button + the shared click-to-fullscreen affordance; double-click also opens.
4. **Zoom model?** — transform-based (scale + translate), wheel = zoom, drag = pan, pinch = zoom; reset on close.

---

## Screen layouts

### Fullscreen zoom overlay (shared, image + mermaid)

```
┌──────────────────────────────────────────────┐
│  ✕  (close, top-right)                       │  ← always visible
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │                                        │  │
│  │        [zoomable content —             │  │
│  │         image or mermaid SVG]          │  │
│  │   wheel / pinch = zoom                 │  │
│  │   drag = pan                           │  │
│  └────────────────────────────────────────┘  │
│  dark backdrop, body scroll locked           │
└──────────────────────────────────────────────┘
```

Notes:
- Esc or ✕ closes
- Double-click on image inside also toggles fullscreen (markdown + preview)
- Mermaid click only opens fullscreen (not toggle-close) to avoid text-select conflicts

---

## Priority & sequencing

| Order | Sub-feature | Depends on | Can ship independently? |
|-------|-------------|------------|------------------------|
| 1 | Shared `ZoomableMedia` + fullscreen overlay component | — | Yes |
| 2 | Rich Chat images (TODO 1) | 1 | Yes |
| 3 | File preview images (TODO 2) | 1 | Yes |
| 4 | Mermaid fullscreen (TODO 3) | 1 | No (needs overlay) |

---

## Open questions

| # | Question | Proposed answer / owner |
|---|----------|------------------------|
| 1 | Should inline markdown images also be click-to-fullscreen, or only preview images? | Both — R8 says markdown images open fullscreen on click |
