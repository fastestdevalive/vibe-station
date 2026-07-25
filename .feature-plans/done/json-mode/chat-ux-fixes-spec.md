# Implementation spec — 6 "fix right away" chat-UX items (fable-reviewed)

Accent decision: **mid-gray, quiet.** Dark `--chat-accent: #8a8a8a`, light `#737373` (AA-verified). Contain via a NEW token, do NOT swap global `--accent`.

Implement in this order: **RA6 → RA5 → RA3+RA4 (together) → RA1 → RA2.**

---

## RA1 — Persist composer draft (web-ui)

Root cause: `Composer.tsx:38` holds `text` in `useState` only; `ChatPane.tsx:199` keys Composer by `composerKey` only (bumped on salvage). Composer is NOT keyed by sessionId → drafts (and `useAttachmentDrafts`) bleed across sessions (latent bug).

1. New hook `web-ui/src/hooks/useComposerDraft.ts`:
   - Key `` `vst-chat-draft-${sessionId}` `` (precedent: `vst-last-model-${cli}`).
   - `loadDraft(sessionId): string` module fn, `try/catch → ""`, `typeof window` guard.
   - `save(text)` debounced ~400ms via setTimeout ref; empty/whitespace → `removeItem`.
   - `clear()` cancels pending timer AND removes key.
   - Unmount cleanup flushes pending write synchronously (skip `beforeunload`).
2. `Composer.tsx`:
   - Seed: `useState(() => initialText ?? loadDraft(sessionId))` — salvage `initialText` WINS over stored draft.
   - `onChange` → `setText(v); draft.save(v)`.
   - `handleSend` success (next to `setText("")` at :57) → `draft.clear()`. On throw, text+draft survive.
   - Do NOT write seed to storage on mount — only user edits persist.
   - Text only (no attachment ids).
3. `ChatPane.tsx:199`: `key={composerKey}` → `` key={`${sessionId}:${composerKey}`} `` (fixes per-session seed + cross-session bleed).

Tests: new `useComposerDraft.test.ts` (fake timers: debounce, empty→remove, clear cancels, unmount flush). Extend `Composer.test.tsx`: seeds from stored draft; initialText beats draft; send removes key; per-session isolation. Clear localStorage in beforeEach.

---

## RA2 — Mermaid in agent messages (web-ui) — DO LAST

Route: `TextMessage.tsx:29` → `StreamingMarkdown.tsx:25` → `MarkdownView` (no mermaid). Reuse `FilePreviewPane.tsx:237-246` pattern.

**Streaming guard (key insight):** `segmentMarkdownWithMermaid` regex (`mdSegments.ts:8`, `/```mermaid\n([\s\S]*?)```/g`) only matches a GENUINELY CLOSED fence. So: **segment the RAW source first, THEN apply `closeUnterminatedFences` per markdown segment.** In-progress mermaid stays in the trailing markdown segment → synthetic-closed → renders as code block until real ``` arrives → flips to MermaidView once. No streaming flags needed.

1. `StreamingMarkdown.tsx` (keep `closeUnterminatedFences` exported, unchanged):
   ```tsx
   const { theme } = useTheme();                       // pattern: CodeView.tsx:18
   const segments = useMemo(() => segmentMarkdownWithMermaid(source), [source]);
   return (
     <div className="chat-md-segments">
       {segments.map((seg, i) => seg.type === "markdown"
         ? <MarkdownView key={i} source={closeUnterminatedFences(seg.content)} />
         : <MermaidView key={i} chart={seg.content} theme={theme} />)}
     </div>
   );
   ```
   Index keys safe (segments only append during streaming).
2. **`MermaidView.tsx` — MANDATORY hardening** (today `void run()` has no catch → unhandled rejection + blank host + leftover artifact in body; models emit invalid mermaid routinely → P0):
   - `const [failed, setFailed] = useState(false)`; reset when `chart` changes.
   - In effect: `const ok = await mermaid.parse(chart, { suppressErrors: true }); if (!ok) { setFailed(true); return; }` then `try { render } catch { setFailed(true); document.getElementById(\`mmd-${uid}\`)?.remove(); }` (remove mermaid temp `d`-prefixed element if present).
   - `cancelled` flag for async race on rapid chart changes.
   - `if (failed) return <pre className="mermaid-fallback"><code>{chart}</code></pre>;`
   - Host div `className="mermaid-view"`; CSS `.mermaid-view svg { max-width: 100%; height: auto; }`.
   - Keep `securityLevel: "strict"`.
3. `chat.css`: `.chat-md-segments { display: flex; flex-direction: column; gap: var(--space-2); }`.

Notes: MermaidView effect deps `[chart, theme, uid]` already prevent re-render storms (closed segment content is stable) — no memo needed. `ThinkingBlock.tsx:26` also routes through StreamingMarkdown → mermaid in thinking blocks too (fine).

Tests: `StreamingMarkdown.test.tsx` (`vi.mock("mermaid")`): closed fence → mermaid host + prose intact; unterminated mid-stream → code block, no mermaid host; existing 3 tests still pass. New `MermaidView.test.tsx`: parse false → `<pre>` fallback; render reject → fallback, no unhandled rejection.

---

## RA3 — Purple → mid-gray accent (web-ui) — DO WITH RA4

Contain via new token (do NOT swap global `--accent`; that would neutralize primary buttons, input focus, hljs, links, top-bar — out of scope). Define at THEME level (not `.chat-pane`-scoped — the attachment picker renders in create dialogs outside the pane):

- `tokens.css` `[data-theme="dark"]` → `--chat-accent: #8a8a8a;`
- `tokens.css` `[data-theme="light"]` → `--chat-accent: #737373;`

`chat.css` surface swaps (`var(--accent)` → `var(--chat-accent)`):

| Line | Selector | Final |
|---|---|---|
| 275 | `.chat-queued-tray__row:focus-visible` | `outline: 2px solid var(--chat-accent)` |
| 326 | `.chat-queued-tray__badge` | `color: var(--chat-accent)` |
| 345 | `.chat-thinking-hint__dot` | `background: var(--chat-accent)` |
| 365 | `.chat-queued-editor` | border `var(--chat-accent)` |
| 371 | `.chat-queued-editor--dragover` | `color-mix(in srgb, var(--chat-accent) 8%, var(--bg-card))` |
| 532 | `.chat-composer--dragover` | dashed `var(--chat-accent)` |
| 584-588 | `.chat-composer__send` | bg/border `var(--chat-accent)`; KEEP `color: var(--fg-inverse)` (AA-verified) |
| 609 | `.attachment-picker--dragover` | `border-color: var(--chat-accent)` |
| 675 | `.chat-spinner` | `border-top-color: var(--chat-accent)` |
| 89-90 | `.chat-bubble--user` | accent REMOVED — see RA4 bubble spec |
| 658-666 | `.chat-bubble--user .chat-attachment-chip` overrides | DELETE whole block (default chip styling correct again) |

Model-switch active option (regression fix — gray text would be dimmer than inactive). Replace `chat.css:493-496`:
```css
.chat-model-switch__option--active {
  color: var(--fg-primary);
  font-weight: var(--font-weight-medium, 600);
  background: var(--bg-active);
}
```

Leave `workspace.css`/`LoginScreen.css` purple untouched (containment — global purple stays elsewhere).

---

## RA4 — Copilot-style agent messages (web-ui) — DO WITH RA3

`chat.css` ONLY (never touch workspace.css — file preview shares it).

1. Assistant bubble (replace :93-97):
   ```css
   .chat-bubble--assistant {
     background: none;
     border: none;
     border-radius: 0;
     padding: 0;
     max-width: 100%;
   }
   ```
2. Scoped markdown override (scope by `.chat-pane` — covers assistant bubbles AND thinking blocks, cannot reach file preview):
   ```css
   .chat-pane .workspace-markdown-preview {
     padding: 0;
     background: transparent;
   }
   .chat-pane .workspace-markdown-preview > :first-child { margin-top: 0; }
   .chat-pane .workspace-markdown-preview > :last-child { margin-bottom: 0; }
   ```
3. Joint final user-bubble spec (replace :88-92):
   ```css
   .chat-bubble--user {
     background: var(--bg-elevated);
     border: var(--border-width) solid var(--border-default);
     color: var(--fg-primary);
     border-bottom-right-radius: var(--radius-sm);
   }
   ```
   Right-align/width unchanged (`.chat-msg--user` :71-73; base cap :84 still applies to user). `--fg-inverse` no longer in chat.css.
4. Keep `.chat-message-list` gap `--space-3` initially.

Notes: tool/error cards already full-width (direct flex children, `MessageList.tsx:190`) → text becomes consistent, not a regression. Keep `overflow-x:auto` on `.chat-bubble`. Pending opacity still works.

Tests: CSS-only; verify visually dark+light (long markdown, tool adjacency, user chips, pending).

---

## RA5 — Center thinking/running indicators (web-ui)

Real bug: `.chat-statusbar__state` (`StatusBar.tsx:77-81`) is a bare inline span with no display rule → inline-block spinner aligns to text BASELINE. `chat.css`:
```css
.chat-statusbar__state {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.chat-thinking-hint { line-height: 1; }
```
(`line-height:1` on spinner/dot themselves is a no-op — put on hint container.) Other spinner sites already centered. Visual only.

---

## RA6 — Suppress "rate limit: unknown" (daemon) — DO FIRST

`daemon/src/agent-plugins/claude.ts:176-185`. Claude-only (other plugins clean, confirmed). Whitelist throttle statuses, suppress everything else:
```ts
if (type === "rate_limit_event") {
  const rl = (msg.rate_limit ?? {}) as Record<string, unknown>;
  const raw = typeof rl.status === "string" ? rl.status
            : typeof msg.status === "string" ? msg.status : "";
  const status = raw.toLowerCase();
  const THROTTLE_STATUSES = new Set(["rejected", "throttled", "queued"]);
  if (!THROTTLE_STATUSES.has(status)) return []; // benign/heartbeat/unknown → drop
  events.push(claudeEvent(sessionId, "status", { text: `rate limit: ${status}` }));
  return events;
}
```
Comment that a novel throttle status would be dropped (acceptable; better than today's noise). `allowed`/`allowed_warning` heartbeats are what's spamming — suppressed intentionally.

Tests (`claudeJson.test.ts`): keep `rejected`; add `{rate_limit:{status:"allowed"}}`→`[]`; `{type:"rate_limit_event"}` no status→`[]`; top-level `{status:"throttled"}`→emitted; `"Rejected"`→emitted lowercased.

---

## Validation
- `cd cli && pnpm typecheck && pnpm exec vitest run` (daemon).
- `cd web-ui && pnpm typecheck && pnpm exec vitest run` (web-ui).
- Pre-existing unrelated failures (do NOT fix): `modes.test.ts` gemini defaultModel, `plugins.test.ts` claude `--chrome`.
