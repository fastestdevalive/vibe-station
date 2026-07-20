/**
 * DEV-ONLY visual gallery for the JSON agent chat UI.
 *
 * Renders the REAL chat components (ChatPane, MessageList, StatusBar,
 * AttachmentPicker/Chip, TabsStrip, DirectAgentDialog) against the in-repo mock
 * API, one scene per `?scene=` query param. Not referenced by index.html, so it
 * is excluded from `vite build`; used only by the screenshot harness.
 */
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { createMockApi } from "@/api/mock";
import type { Attachment, NormalizedEvent, Session, SessionMeta } from "@/api/types";
import { ChatPane } from "@/components/layout/ChatPane";
import { MessageList } from "@/components/chat/MessageList";
import { QueuedTray, type QueuedTrayRow } from "@/components/chat/QueuedTray";
import { StatusBar } from "@/components/chat/StatusBar";
import { AttachmentChip } from "@/components/chat/AttachmentChip";
import { AttachmentPicker } from "@/components/chat/AttachmentPicker";
import { TabsStrip } from "@/components/layout/TabsStrip";
import { DirectAgentDialog } from "@/components/dialogs/DirectAgentDialog";

import "@/styles/tokens.css";
import "@/styles/global.css";
import "@/styles/workspace.css";
import "@/styles/chat.css";

type MockApi = ReturnType<typeof createMockApi>;

const nowIso = () => new Date().toISOString();
let seq = 0;
function mk(sessionId: string, kind: NormalizedEvent["kind"], extra: Partial<NormalizedEvent>): NormalizedEvent {
  return { id: `e${++seq}`, sessionId, ts: nowIso(), provider: "claude", kind, ...extra };
}

function jsonSession(id: string): Session {
  return {
    id,
    worktreeId: "wt-1",
    projectId: "proj-a",
    modeId: "mode-1",
    type: "agent",
    label: "main",
    slot: "m",
    state: "working",
    lifecycleState: "working",
    tmuxName: id,
    channel: "json",
    createdAt: nowIso(),
  };
}

const ASSISTANT_MD = `Here's the plan for refactoring \`parseConfig\`:

1. Switch validation to the **v2 schema**
2. Preserve legacy keys via \`normalizeLegacyKeys\`
3. Add a regression test for the empty-string fallback

\`\`\`ts
export function parseConfig(raw: string): Config {
  const json = JSON.parse(raw);
  const result = ConfigSchemaV2.safeParse(json);
  if (!result.success) {
    throw new ConfigError(result.error.issues);
  }
  return normalizeLegacyKeys(result.data);
}
\`\`\`

Applying the edit now, then I'll run the suite.`;

const THINKING_MD = `The old parser used \`ConfigSchemaV1\`, which silently dropped unknown keys — a migration hazard. I'll route unknown keys through \`normalizeLegacyKeys\` so downstream migrations keep them, and cover the empty-string branch that currently throws an opaque \`SyntaxError\`.`;

const EDIT_DIFF = `diff --git a/src/config/parseConfig.ts b/src/config/parseConfig.ts
index 8a1f2c3..b2d4e5f 100644
--- a/src/config/parseConfig.ts
+++ b/src/config/parseConfig.ts
@@ -1,8 +1,11 @@
-import { ConfigSchemaV1 } from "./schema";
+import { ConfigSchemaV2 } from "./schema";
+import { normalizeLegacyKeys } from "./legacy";

 export function parseConfig(raw: string): Config {
   const json = JSON.parse(raw);
-  return ConfigSchemaV1.parse(json);
+  const result = ConfigSchemaV2.safeParse(json);
+  if (!result.success) throw new ConfigError(result.error.issues);
+  return normalizeLegacyKeys(result.data);
 }
`;

const USER_ATTACHMENT: Attachment = {
  id: "att-legacy",
  name: "config.legacy.json",
  path: "/uploads/att-legacy",
  size: 2048,
  mime: "application/json",
};

function seedFullThread(api: MockApi, sid: string) {
  api.__test.pushChatEvent(sid, mk(sid, "user", {
    role: "user",
    turnId: "turn-1",
    text: "Refactor the `parseConfig` helper to use the v2 schema and add a test for the legacy-key fallback.",
    attachments: [USER_ATTACHMENT],
  }));
  api.__test.pushChatEvent(sid, mk(sid, "thinking", { turnId: "turn-1", text: THINKING_MD }));
  api.__test.pushChatEvent(sid, mk(sid, "text", { role: "assistant", turnId: "turn-1", text: ASSISTANT_MD }));
  api.__test.pushChatEvent(sid, mk(sid, "tool_use", {
    turnId: "turn-1",
    toolName: "Edit",
    toolId: "tool-edit-1",
    toolInput: {
      file_path: "src/config/parseConfig.ts",
      old_string: "return ConfigSchemaV1.parse(json);",
      new_string: "const result = ConfigSchemaV2.safeParse(json);",
    },
  }));
  api.__test.pushChatEvent(sid, mk(sid, "tool_result", {
    turnId: "turn-1",
    toolName: "Edit",
    toolId: "tool-edit-1",
    toolResult: { content: EDIT_DIFF, isError: false },
  }));
  api.__test.pushChatEvent(sid, mk(sid, "error", {
    turnId: "turn-2",
    text: "Turn interrupted: upstream rate limit reached (HTTP 429). Retry when ready.",
  }));
}

function seedRunningThread(api: MockApi, sid: string) {
  api.__test.pushChatEvent(sid, mk(sid, "user", {
    role: "user", turnId: "turn-1",
    text: "Run the full test suite and report any failures.",
  }));
  api.__test.pushChatEvent(sid, mk(sid, "text", {
    role: "assistant", turnId: "turn-1",
    text: "Running the suite now — this may take a moment.",
  }));
  api.__test.pushChatEvent(sid, mk(sid, "tool_use", {
    turnId: "turn-1",
    toolName: "Bash",
    toolId: "tool-bash-1",
    toolInput: { command: "pnpm test" },
  }));
}

function usage(total: number): SessionMeta["usage"] {
  return {
    inputTokens: 18240,
    outputTokens: 3120,
    cacheReadTokens: 40000,
    cacheCreateTokens: 0,
    totalTokens: total,
    contextWindow: 200000,
    costUsd: 0.142,
    model: "claude-sonnet-4-5",
  };
}

function meta(sessionId: string, turnState: SessionMeta["turnState"], queueDepth = 0, total = 61360): SessionMeta {
  return {
    sessionId,
    channel: "json",
    modeId: "mode-1",
    modeName: "Bugfix",
    cli: "claude",
    model: "claude-sonnet-4-5",
    turnState,
    queueDepth,
    queuedTurnIds: [],
    editingTurnIds: [],
    usage: usage(total),
  };
}

/** Emits a `session:meta` event after the ChatPane has subscribed. */
function MetaEmitter({ api, value }: { api: MockApi; value: SessionMeta }) {
  useEffect(() => {
    const t = window.setTimeout(() => {
      api.__test.emit({ type: "session:meta", sessionId: value.sessionId, meta: value });
    }, 80);
    return () => window.clearTimeout(t);
  }, [api, value]);
  return null;
}

function Pane({ children }: { children: React.ReactNode }) {
  return <div className="gallery-pane">{children}</div>;
}

// ── Scenes ──────────────────────────────────────────────────────────────────

function ChatScene({ running }: { running: boolean }) {
  const sid = running ? "sess-running" : "sess-thread";
  // Seed inside the api factory so StrictMode's double-invocation seeds each
  // (discarded) instance exactly once — a separate memo would double-seed the
  // retained instance.
  const api = useMemo(() => {
    const a = createMockApi();
    if (running) seedRunningThread(a, sid);
    else seedFullThread(a, sid);
    return a;
  }, [sid, running]);
  const session = useMemo(() => jsonSession(sid), [sid]);
  const m = meta(sid, running ? "tool" : "idle");
  return (
    <Pane>
      <MetaEmitter api={api} value={m} />
      <ChatPane api={api} session={session} visible />
    </Pane>
  );
}

function EmptyScene() {
  const api = useMemo(() => createMockApi(), []);
  const session = useMemo(() => jsonSession("sess-empty"), []);
  return (
    <Pane>
      <MetaEmitter api={api} value={meta("sess-empty", "idle", 0, 0)} />
      <ChatPane api={api} session={session} visible />
    </Pane>
  );
}

function LoadingScene() {
  const api = useMemo(() => {
    const a = createMockApi();
    // Never emit chat:replay → useChat stays in its loading state.
    a.openChat = async () => {};
    return a;
  }, []);
  const session = useMemo(() => jsonSession("sess-loading"), []);
  return (
    <Pane>
      <ChatPane api={api} session={session} visible />
    </Pane>
  );
}

function StatusBarScene() {
  return (
    <div className="gallery-stack">
      <div className="gallery-label">idle</div>
      <div id="sb-idle" className="gallery-statusbar-wrap">
        <StatusBar meta={meta("s1", "idle")} />
      </div>
      <div className="gallery-label">responding (spinner + Stop)</div>
      <div id="sb-responding" className="gallery-statusbar-wrap">
        <StatusBar meta={meta("s2", "responding")} onStop={() => {}} />
      </div>
      <div className="gallery-label">queued</div>
      <div id="sb-queued" className="gallery-statusbar-wrap">
        <StatusBar meta={meta("s3", "queued", 2)} queueDepth={2} />
      </div>
    </div>
  );
}

function QueuedScene() {
  const sid = "sess-queued";
  const events: NormalizedEvent[] = [
    mk(sid, "user", { role: "user", turnId: "turn-8", text: "Add the `--json` flag to the CLI and document it." }),
    mk(sid, "text", { role: "assistant", turnId: "turn-8", text: "Done — the flag is wired up and the README table is updated." }),
  ];
  return (
    <Pane>
      <div className="chat-pane__body">
        <MessageList
          events={events}
          pending={[{ turnId: "turn-9", message: "Also bump the version and update the changelog.", attachments: [], queued: true }]}
          turnActive
          hiddenTurnIds={new Set(["turn-9"])}
        />
      </div>
      <div className="chat-pane__footer">
        <StatusBar meta={meta(sid, "queued", 1)} queueDepth={1} onStop={() => {}} />
      </div>
    </Pane>
  );
}

function chip(name: string, size: number): Attachment {
  return { id: `c-${name}`, name, path: `/uploads/${name}`, size, mime: "application/octet-stream" };
}

function AttachmentsScene() {
  const [files, setFiles] = useState<File[]>(() => [
    new File([new ArrayBuffer(2048)], "config.legacy.json", { type: "application/json" }),
    new File([new ArrayBuffer(15360)], "screenshot.png", { type: "image/png" }),
  ]);
  const sent: Attachment[] = [chip("failing-run.log", 348 * 1024), chip("config.json", 2048)];
  return (
    <div className="gallery-stack">
      <div className="gallery-label">Composer draft chips — mid-upload / error / ready</div>
      <div className="chat-composer" style={{ maxWidth: 460 }}>
        <div className="chat-composer__chips">
          <AttachmentChip attachment={chip("debug.log", 348 * 1024)} status="uploading" onRemove={() => {}} />
          <AttachmentChip attachment={chip("huge-trace.bin", 42 * 1024 * 1024)} status="error" onRemove={() => {}} />
          <AttachmentChip attachment={chip("config.json", 2048)} onRemove={() => {}} />
        </div>
      </div>

      <div className="gallery-label">AttachmentPicker — 2 files staged (create dialog)</div>
      <div style={{ maxWidth: 460 }}>
        <AttachmentPicker files={files} onChange={setFiles} />
      </div>

      <div className="gallery-label">Attachment shown in a sent user message</div>
      <div className="gallery-pane" style={{ height: "auto" }}>
        <div className="chat-pane__body" style={{ padding: "var(--space-3)" }}>
          <MessageList
            events={[mk("s", "user", {
              role: "user",
              text: "Here are the failing logs and the config — can you dig into the crash?",
              attachments: sent,
            })]}
            pending={[]}
          />
        </div>
      </div>
    </div>
  );
}

function QueueControlsScene() {
  const api = useMemo(() => createMockApi(), []);
  const sid = "sess-qc";
  const events: NormalizedEvent[] = [
    mk(sid, "user", { role: "user", turnId: "turn-8", text: "Add the `--json` flag to the CLI and document it." }),
    mk(sid, "text", {
      role: "assistant",
      turnId: "turn-8",
      text: "Done — the flag is wired up and the README table is updated.",
    }),
    mk(sid, "user", { role: "user", turnId: "turn-9", text: "Also bump the version and update the changelog." }),
  ];
  const noop = () => {};
  const trayProps = {
    api,
    sessionId: sid,
    onEdit: noop,
    onSendNow: noop,
    onCancel: noop,
    onSave: async () => {},
    onDiscard: noop,
    onSalvage: noop,
  };
  const queuedRows: QueuedTrayRow[] = [
    { turnId: "turn-9", text: "Also bump the version and update the changelog.", status: "queued" },
    { turnId: "turn-10", text: "Then run the test suite once more.", status: "queued" },
  ];
  const editingRows: QueuedTrayRow[] = [
    {
      turnId: "turn-9",
      text: "Also bump the version and update the changelog.",
      status: "editing",
      draft: { message: "Also bump the version and update the changelog, and tag the release.", attachments: [] },
    },
  ];
  // The inline chat log with queued turns hidden (they live in the tray below).
  const hidden = new Set(["turn-9", "turn-10"]);
  return (
    <div className="gallery-stack">
      <div className="gallery-label">Queued tray — oldest on top · Send now ⏭ · Edit ✎ · Cancel ✕</div>
      <div className="gallery-pane" style={{ height: "auto" }}>
        <div className="chat-pane__body" style={{ padding: "var(--space-3)" }}>
          <MessageList events={events} pending={[]} hiddenTurnIds={hidden} />
        </div>
        <div className="chat-pane__footer">
          <QueuedTray {...trayProps} rows={queuedRows} />
        </div>
      </div>

      <div className="gallery-label">Editing a queued message — inline editor (prefilled)</div>
      <div className="gallery-pane" style={{ height: "auto" }}>
        <div className="chat-pane__footer">
          <QueuedTray {...trayProps} rows={editingRows} />
        </div>
      </div>
    </div>
  );
}

function TabStripScene() {
  const api = useMemo(() => {
    const a = createMockApi();
    a.listSessions = async () => ([
      { id: "a-json", worktreeId: "wt-1", projectId: "proj-a", modeId: "mode-1", type: "agent", label: "main", slot: "m", state: "working", lifecycleState: "working", tmuxName: "a-json", channel: "json", createdAt: nowIso() },
      { id: "a-term", worktreeId: "wt-1", projectId: "proj-a", modeId: "mode-1", type: "agent", label: "agent-2", slot: "a1", state: "idle", lifecycleState: "idle", tmuxName: "a-term", channel: "tmux", createdAt: nowIso() },
    ] as Session[]);
    return a;
  }, []);
  return (
    <div className="gallery-tabstrip">
      <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
    </div>
  );
}

function CreateDialogScene() {
  const api = useMemo(() => createMockApi(), []);
  return (
    <BrowserRouter>
      <DirectAgentDialog
        open
        api={api}
        projectId="proj-a"
        projectName="Proj A"
        onClose={() => {}}
        onCreated={() => {}}
      />
    </BrowserRouter>
  );
}

const GALLERY_CSS = `
  body { margin: 0; background: var(--bg-secondary); color: var(--fg-primary);
    font-family: var(--font-sans); }
  .gallery-root { padding: 24px; display: flex; flex-direction: column;
    align-items: flex-start; gap: 20px; min-height: 100vh; box-sizing: border-box; }
  .gallery-pane { width: 460px; height: 820px; display: flex; flex-direction: column;
    background: var(--bg-primary); border: 1px solid var(--border, #2a2a2a);
    border-radius: 10px; overflow: hidden; }
  .gallery-stack { display: flex; flex-direction: column; gap: 10px; }
  .gallery-label { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--fg-muted); font-family: var(--font-mono); }
  .gallery-statusbar-wrap { width: 460px; background: var(--bg-primary);
    border: 1px solid var(--border, #2a2a2a); border-radius: 8px; overflow: hidden; }
  .gallery-tabstrip { width: 640px; background: var(--bg-secondary);
    border: 1px solid var(--border, #2a2a2a); border-radius: 8px; overflow: hidden; }
`;

function App() {
  const scene = new URLSearchParams(window.location.search).get("scene") ?? "chat";
  let body: React.ReactNode;
  switch (scene) {
    case "chat": body = <ChatScene running={false} />; break;
    case "chat-running": body = <ChatScene running />; break;
    case "empty": body = <EmptyScene />; break;
    case "loading": body = <LoadingScene />; break;
    case "statusbar": body = <StatusBarScene />; break;
    case "queued": body = <QueuedScene />; break;
    case "queue-controls": body = <QueueControlsScene />; break;
    case "attachments": body = <AttachmentsScene />; break;
    case "tabstrip": body = <TabStripScene />; break;
    case "create-json": body = <CreateDialogScene />; break;
    default: body = <div style={{ color: "#e5e5e5" }}>Unknown scene: {scene}</div>;
  }
  return (
    <>
      <style>{GALLERY_CSS}</style>
      <div className="gallery-root" data-scene={scene}>{body}</div>
    </>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
