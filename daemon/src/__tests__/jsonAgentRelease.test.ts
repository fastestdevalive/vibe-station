/**
 * `JsonAgentSession.release()` — the teardown used by "mark as done" (and by
 * delete). The interesting property is not that it frees things, but that it
 * LATCHES the session so nothing can write after it: the aborted turn's drain
 * would otherwise persist a trailing lifecycle `idle` that lands after the
 * caller has written `done`, silently un-doing the user's action.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPlugin, TurnContext, TurnInput } from "../services/spawn.js";
import type { ProjectRecord, SessionRecord, NormalizedEvent } from "../types.js";

let tempDir: string;

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  const base = () => tempDir;
  const directDataDir = (p: string, s: string) => pathJoin(base(), "projects", p, "sessions", s);
  return {
    vstHome: () => base(),
    projectDir: (id: string) => pathJoin(base(), "projects", id),
    manifestPath: (id: string) => pathJoin(base(), "projects", id, "manifest.json"),
    manifestTmpPath: (id: string) => pathJoin(base(), "projects", id, "manifest.json.tmp"),
    worktreePath: (id: string, wtId: string) => pathJoin(base(), "projects", id, "worktrees", wtId),
    configPath: () => pathJoin(base(), "config.json"),
    modesPath: () => pathJoin(base(), "modes.json"),
    daemonLogPath: () => pathJoin(base(), "logs", "daemon.log"),
    sessionDataDir: (p: string, w: string, s: string) =>
      pathJoin(base(), "projects", p, "session-data", w, s),
    directSessionDataDir: directDataDir,
    systemPromptPath: (p: string, w: string, s: string) =>
      pathJoin(base(), "projects", p, "session-data", w, s, "system-prompt.md"),
    directSystemPromptPath: (p: string, s: string) => pathJoin(directDataDir(p, s), "system-prompt.md"),
    cleanupDirectSessionDataDir: () => {},
  };
});

const PROJECT_ID = "proj-rel";

function makeSession(): SessionRecord {
  return {
    id: `${PROJECT_ID}-d1`,
    slot: "d1",
    type: "agent",
    modeId: "m",
    tmuxName: "__direct__-x",
    useTmux: false,
    channel: "json",
    lifecycle: { state: "working", lastTransitionAt: new Date().toISOString() },
  };
}

/** A plugin whose turn blocks forever until aborted. */
function makeGatePlugin(): { plugin: AgentPlugin; running: () => boolean } {
  let started = false;
  const plugin = {
    name: "claude",
    defaultModel: "sonnet",
    promptDelivery: "inline",
    async listModels() {
      return { models: [] };
    },
    getLaunchCommand() {
      return ["claude"];
    },
    getEnvironment() {
      return {};
    },
    getReadySignal() {
      return { fallbackMs: 0 };
    },
    composeLaunchPrompt() {
      return {};
    },
    supportsJson() {
      return true;
    },
    async *runTurn(_input: TurnInput, ctx: TurnContext, signal: AbortSignal): AsyncIterable<NormalizedEvent> {
      started = true;
      yield {
        id: "init",
        sessionId: ctx.session.id,
        ts: new Date().toISOString(),
        provider: "claude",
        kind: "session_init",
        agentChatId: "chat-1",
      } as NormalizedEvent;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      // A straggler event emitted as the aborted turn unwinds — this is what
      // would hit a closed SQLite handle without the `released` latch.
      yield {
        id: "straggler",
        sessionId: ctx.session.id,
        ts: new Date().toISOString(),
        provider: "claude",
        kind: "text",
        text: "late",
      } as NormalizedEvent;
    },
  } as unknown as AgentPlugin;
  return { plugin, running: () => started };
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("1.T4 — JsonAgentSession.release()", () => {
  let project: ProjectRecord;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-jsonrel-"));
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    _clearStoreForTest();
    project = {
      id: PROJECT_ID,
      absolutePath: join(tempDir, "repo"),
      prefix: "pr",
      isGit: true,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      directSessions: [makeSession()],
      worktrees: [],
    };
    await addProject(project);
  });

  afterEach(async () => {
    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    jsonAgentRegistry.clear();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("does not persist a trailing `idle` after release (would demote a done session)", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { getAllProjects } = await import("../state/project-store.js");
    const { plugin, running } = makeGatePlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({
      project,
      worktree: null,
      session,
      plugin,
      daemonPort: 0,
      cli: "claude",
    });

    agent.enqueue({ message: "hello" });
    await waitFor(() => running());

    await agent.release();
    // Let any late drain callback land — without the latch this is exactly the
    // window in which `persistLifecycle("idle")` used to fire.
    await new Promise((r) => setTimeout(r, 100));

    const stored = getAllProjects()
      .find((p) => p.id === PROJECT_ID)!
      .directSessions.find((s) => s.id === session.id)!;
    expect(stored.lifecycle.state).not.toBe("idle");
  });

  it("survives a straggler event emitted after the store is closed", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin, running } = makeGatePlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({
      project,
      worktree: null,
      session,
      plugin,
      daemonPort: 0,
      cli: "claude",
    });

    agent.enqueue({ message: "hello" });
    await waitFor(() => running());

    await expect(agent.release()).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("is idempotent — a second release is a no-op", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin } = makeGatePlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({
      project,
      worktree: null,
      session,
      plugin,
      daemonPort: 0,
      cli: "claude",
    });

    await agent.release();
    await expect(agent.release()).resolves.toBeUndefined();
  });
});
