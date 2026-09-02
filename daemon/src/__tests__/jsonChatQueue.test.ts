import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { AgentPlugin, TurnContext, TurnInput } from "../services/spawn.js";
import type { ProjectRecord, SessionRecord, NormalizedEvent } from "../types.js";

let tempDir: string;

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  const { rmSync } = await import("node:fs");
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
    dbPath: () => pathJoin(base(), "vibe-station.db"),
    sessionDataDir: (p: string, w: string, s: string) =>
      pathJoin(base(), "projects", p, "session-data", w, s),
    directSessionDataDir: directDataDir,
    systemPromptPath: (p: string, w: string, s: string) =>
      pathJoin(base(), "projects", p, "session-data", w, s, "system-prompt.md"),
    directSystemPromptPath: (p: string, s: string) => pathJoin(directDataDir(p, s), "system-prompt.md"),
    cleanupDirectSessionDataDir: (p: string, s: string) => {
      rmSync(directDataDir(p, s), { recursive: true, force: true });
    },
  };
});

const PROJECT_ID = "proj-q";

function makeSession(): SessionRecord {
  return {
    id: `${PROJECT_ID}-d1`,
    slot: "d1",
    type: "agent",
    modeId: "m",
    tmuxName: "__direct__-x",
    useTmux: false,
    channel: "json",
    lifecycle: { state: "not_started", lastTransitionAt: new Date().toISOString() },
  };
}

/** A plugin whose each turn blocks on a per-turn gate until released. */
function makeGatePlugin(): {
  plugin: AgentPlugin;
  started: string[];
  /** Per-turn `input.isFirstTurn`, indexed by start order (parallel to `started`). */
  firstTurns: boolean[];
  release: (index: number) => void;
  gatesReady: () => number;
} {
  const started: string[] = [];
  const firstTurns: boolean[] = [];
  const gates: Array<() => void> = [];
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
    // Stands in for claude — the only plugin whose mid-turn steering is trusted.
    supportsMidTurnSteering() {
      return true;
    },
    async *runTurn(input: TurnInput, ctx: TurnContext, signal: AbortSignal): AsyncIterable<NormalizedEvent> {
      const idx = started.length;
      started.push(input.message);
      firstTurns.push(input.isFirstTurn === true);
      yield {
        id: `init-${idx}`,
        sessionId: ctx.session.id,
        ts: new Date().toISOString(),
        provider: "claude",
        kind: "session_init",
        agentChatId: "chat-1",
      } as NormalizedEvent;
      await new Promise<void>((resolve) => {
        gates.push(resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      if (signal.aborted) return;
      yield {
        id: `text-${idx}`,
        sessionId: ctx.session.id,
        ts: new Date().toISOString(),
        provider: "claude",
        kind: "text",
        text: `answer ${input.message}`,
      } as NormalizedEvent;
      yield {
        id: `result-${idx}`,
        sessionId: ctx.session.id,
        ts: new Date().toISOString(),
        provider: "claude",
        kind: "result",
      } as NormalizedEvent;
    },
  } as unknown as AgentPlugin;
  return { plugin, started, firstTurns, release: (i) => gates[i]?.(), gatesReady: () => gates.length };
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("3.T3 — JSON turn queue (FIFO)", () => {
  let project: ProjectRecord;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-jsonq-"));
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    _clearStoreForTest();
    project = {
      id: PROJECT_ID,
      absolutePath: join(tempDir, "repo"),
      prefix: "pq",
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

  it("second turn gets queuePosition 1 and runs only after turn 1's result", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin, started, release, gatesReady } = makeGatePlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({ project, worktree: null, session, plugin, daemonPort: 0, cli: "claude" });

    const a = agent.enqueue({ message: "A" });
    const b = agent.enqueue({ message: "B" });
    expect(a.queuePosition).toBe(0);
    expect(b.queuePosition).toBe(1);

    await waitFor(() => gatesReady() >= 1); // A running + blocked on its gate
    expect(started).toEqual(["A"]); // B still queued
    expect(agent.getMeta().queueDepth).toBe(1);

    release(0); // finish A → B dequeues
    await waitFor(() => gatesReady() >= 2); // B now running + blocked
    expect(started).toEqual(["A", "B"]);
    release(1);
    await agent.settled();

    // Both user events are persisted up front at enqueue (Decision 12); the
    // TURN execution is sequential — all of A's runtime events precede all of
    // B's (B ran only after A's result).
    const transcript = agent.readTranscript();
    expect(transcript.filter((e) => e.kind === "user")).toHaveLength(2);
    const runtime = transcript.filter((e) => e.kind !== "user");
    const aIdxs = runtime.flatMap((e, i) => (e.turnId === a.turnId ? [i] : []));
    const bIdxs = runtime.flatMap((e, i) => (e.turnId === b.turnId ? [i] : []));
    expect(Math.max(...aIdxs)).toBeLessThan(Math.min(...bIdxs));
    expect(agent.getMeta().turnState).toBe("idle");
  });

  it("setModel changes the model the NEXT turn spawns with, and reverts on clear", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const models: (string | undefined)[] = [];
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
      async *runTurn(_input: TurnInput, ctx: TurnContext): AsyncIterable<NormalizedEvent> {
        models.push(ctx.model);
        yield {
          id: `res-${models.length}`,
          sessionId: ctx.session.id,
          ts: new Date().toISOString(),
          provider: "claude",
          kind: "result",
        } as NormalizedEvent;
      },
    } as unknown as AgentPlugin;
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({
      project,
      worktree: null,
      session,
      plugin,
      daemonPort: 0,
      cli: "claude",
      model: "sonnet",
    });

    agent.enqueue({ message: "A" });
    await agent.settled();
    expect(models[0]).toBe("sonnet"); // spawns with the seeded model

    await agent.setModel("opus", "sonnet");
    expect(agent.getMeta().model).toBe("opus"); // status bar reflects it immediately
    agent.enqueue({ message: "B" });
    await agent.settled();
    expect(models[1]).toBe("opus"); // next turn spawns with the override

    await agent.setModel(null, "sonnet"); // clear → back to mode default
    expect(agent.getMeta().model).toBe("sonnet");
    agent.enqueue({ message: "C" });
    await agent.settled();
    expect(models[2]).toBe("sonnet");

    // Persisted to the SessionRecord and dropped again on clear.
    const { getProject } = await import("../state/project-store.js");
    const persisted = getProject(PROJECT_ID)?.directSessions[0];
    expect(persisted?.modelOverride).toBeUndefined();
  });

  it("stopActiveTurn aborts the active turn but keeps queued turns", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin, started, release, gatesReady } = makeGatePlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({ project, worktree: null, session, plugin, daemonPort: 0, cli: "claude" });

    agent.enqueue({ message: "A" });
    agent.enqueue({ message: "B" });
    await waitFor(() => gatesReady() >= 1);

    expect(agent.stopActiveTurn()).toBe(true); // aborts A; B kept
    await waitFor(() => gatesReady() >= 2); // B still runs (queue preserved)
    expect(started).toEqual(["A", "B"]);
    release(1);
    await agent.settled();
  });

  it("Fix #3 — a stopped turn appends a terminal 'Turn stopped' status marker", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin, release, gatesReady } = makeGatePlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({ project, worktree: null, session, plugin, daemonPort: 0, cli: "claude" });

    const { turnId } = agent.enqueue({ message: "A" });
    await waitFor(() => gatesReady() >= 1);
    agent.stopActiveTurn();
    await agent.settled();

    // The aborted turn's transcript ends with a status marker (not truncated).
    const transcript = agent.readTranscript();
    const stopped = transcript.find((e) => e.kind === "status" && e.turnId === turnId);
    expect(stopped).toBeDefined();
    expect(stopped?.text).toBe("Turn stopped");
    // No error card for an intentional stop; ends idle (not a stuck spinner).
    expect(transcript.some((e) => e.kind === "error")).toBe(false);
    expect(agent.getMeta().turnState).toBe("idle");
    void release;
  });

  it("cancelQueuedTurn removes a queued (not-yet-started) turn", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin, started, release, gatesReady } = makeGatePlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({ project, worktree: null, session, plugin, daemonPort: 0, cli: "claude" });

    agent.enqueue({ message: "A" });
    const b = agent.enqueue({ message: "B" });
    await waitFor(() => gatesReady() >= 1);

    expect(agent.cancelQueuedTurn(b.turnId)).toBe(true);
    expect(agent.getMeta().queueDepth).toBe(0);

    // The cancelled message stays in history, superseded by a `cancelled:true`
    // user event (last-wins by turnId) so the UI can mark it "not sent".
    const bUsers = agent.readTranscript().filter((e) => e.kind === "user" && e.turnId === b.turnId);
    expect(bUsers.length).toBeGreaterThanOrEqual(2);
    expect(bUsers.at(-1)?.cancelled).toBe(true);
    expect(bUsers.at(-1)?.text).toBe("B");

    release(0);
    await agent.settled();
    expect(started).toEqual(["A"]); // B never ran
  });
});

describe("3.T5 — orphan-process safety + uploads cleanup (Decision 13)", () => {
  let project: ProjectRecord;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-jsonabort-"));
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    _clearStoreForTest();
    project = {
      id: PROJECT_ID,
      absolutePath: join(tempDir, "repo"),
      prefix: "pq",
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

  it("abortAndDrain kills the active turn's process group", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const session = project.directSessions[0]!;
    let spawnedPid = 0;

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
      // eslint-disable-next-line require-yield
      async *runTurn(_input: TurnInput, ctx: TurnContext, signal: AbortSignal) {
        const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
        spawnedPid = child.pid!;
        ctx.onSpawn?.(child.pid!);
        const onAbort = (): void => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            /* dead */
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        await new Promise<void>((resolve) => child.on("close", () => resolve()));
      },
    } as unknown as AgentPlugin;

    const agent = new JsonAgentSession({ project, worktree: null, session, plugin, daemonPort: 0, cli: "claude" });
    agent.enqueue({ message: "long task" });
    await waitFor(() => spawnedPid > 0);

    // pidfile recorded while the turn runs
    const pidFile = join(tempDir, "projects", PROJECT_ID, "sessions", session.id, "turn.pids");
    await waitFor(() => existsSync(pidFile));

    agent.abortAndDrain();
    await agent.settled();

    // The sleep process is dead (kill(pid, 0) throws ESRCH).
    let alive = true;
    try {
      process.kill(spawnedPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
    expect(existsSync(pidFile)).toBe(false); // pidfile cleared
  });

  it("uploads under the session data dir are removed with the session (Decision 5/7)", async () => {
    const { directSessionDataDir, cleanupDirectSessionDataDir } = await import("../services/paths.js");
    const session = project.directSessions[0]!;
    const uploadsDir = join(directSessionDataDir(PROJECT_ID, session.id), "uploads", "u1");
    await mkdir(uploadsDir, { recursive: true });
    await writeFile(join(uploadsDir, "img.png"), "bytes");
    expect(existsSync(uploadsDir)).toBe(true);

    cleanupDirectSessionDataDir(PROJECT_ID, session.id);
    expect(existsSync(directSessionDataDir(PROJECT_ID, session.id))).toBe(false);
  });
});

describe("queue-controls — edit + send-now (queue-controls)", () => {
  let project: ProjectRecord;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-jsonqc-"));
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    _clearStoreForTest();
    project = {
      id: PROJECT_ID,
      absolutePath: join(tempDir, "repo"),
      prefix: "pq",
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

  // 1.T1 — withdraw a queued turn into the editing hold.
  it("beginEditQueuedTurn withdraws from the queue into holds (editingTurnIds)", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin, release, gatesReady } = makeGatePlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({ project, worktree: null, session, plugin, daemonPort: 0, cli: "claude" });

    agent.enqueue({ message: "A" });
    const b = agent.enqueue({ message: "B" });
    await waitFor(() => gatesReady() >= 1); // A running, B queued

    const res = agent.beginEditQueuedTurn(b.turnId);
    expect(res).not.toBe("not_queued");
    if (res === "not_queued") throw new Error("unreachable");
    expect(res.message).toBe("B");
    expect(res.queueIndex).toBe(0);

    const meta = agent.getMeta();
    expect(meta.editingTurnIds).toEqual([b.turnId]);
    expect(meta.queuedTurnIds).toEqual([]);
    expect(meta.queueDepth).toBe(0);

    // Non-queued id → not_queued; re-editing a held turn re-acquires it (A5).
    expect(agent.beginEditQueuedTurn("nope")).toBe("not_queued");
    const again = agent.beginEditQueuedTurn(b.turnId);
    expect(again).not.toBe("not_queued");
    if (again !== "not_queued") expect(again.message).toBe("B");

    release(0);
    await agent.settled();
  });

  // 1.T4 — a held turn is never run by drain; the only-queued case drains to idle
  // (R17), then a resubmit runs it with the edited text + a superseding event.
  it("held turn drains to idle (R17), resubmit re-runs it with edited text", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin, started, release, gatesReady } = makeGatePlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({ project, worktree: null, session, plugin, daemonPort: 0, cli: "claude" });

    agent.enqueue({ message: "A" });
    const b = agent.enqueue({ message: "B" });
    await waitFor(() => gatesReady() >= 1);
    agent.beginEditQueuedTurn(b.turnId);

    release(0); // A completes; B is held (not runnable) → idle
    await agent.settled();
    expect(started).toEqual(["A"]);
    expect(agent.getMeta().turnState).toBe("idle");

    // Resubmit edited → re-enqueue + run with the new text.
    expect(agent.resubmitQueuedTurn(b.turnId, { edited: true, message: "B2", attachments: [] })).toBe("ok");
    await waitFor(() => gatesReady() >= 2);
    expect(started).toEqual(["A", "B2"]);
    release(1);
    await agent.settled();

    // A superseding user event (edited:true) is appended for the same turnId.
    const userEvents = agent.readTranscript().filter((e) => e.kind === "user" && e.turnId === b.turnId);
    expect(userEvents).toHaveLength(2);
    expect(userEvents[0]!.text).toBe("B");
    expect(userEvents[1]!.text).toBe("B2");
    expect(userEvents[1]!.edited).toBe(true);
    // Not-editing after resubmit.
    expect(agent.resubmitQueuedTurn(b.turnId, { edited: false })).toBe("not_editing");
  });

  // 1.T2 (A2) — cancel-ahead while editing preserves relative order on restore.
  it("resubmit re-inserts preserving order after an ahead turn is cancelled (A2)", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin, started, release, gatesReady } = makeGatePlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({ project, worktree: null, session, plugin, daemonPort: 0, cli: "claude" });

    agent.enqueue({ message: "A" });
    const b = agent.enqueue({ message: "B" });
    const c = agent.enqueue({ message: "C" });
    agent.enqueue({ message: "D" });
    await waitFor(() => gatesReady() >= 1); // A running; queue [B, C, D]

    agent.beginEditQueuedTurn(c.turnId); // aheadIds = [B]; queue [B, D]
    expect(agent.cancelQueuedTurn(b.turnId)).toBe(true); // queue [D]
    // Restore C: no ahead turns remain → inserts at front of [D] → [C, D].
    expect(agent.resubmitQueuedTurn(c.turnId, { edited: false })).toBe("ok");
    expect(agent.getMeta().queuedTurnIds).toEqual([c.turnId, expect.any(String)]);

    release(0);
    await waitFor(() => gatesReady() >= 2);
    release(1);
    await waitFor(() => gatesReady() >= 3);
    release(2);
    await agent.settled();
    expect(started).toEqual(["A", "C", "D"]); // B cancelled; C before D preserved
  });

  // 1.T3 — "Send now" preempts: it jumps the target to the front AND aborts the
  // active turn so the promoted one runs next. The aborted turn is dropped
  // (not re-queued), like hitting Stop and re-sending.
  it("promoteQueuedTurn preempts: aborts the running turn, runs the promoted next, drops the aborted", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin, started, release, gatesReady } = makeGatePlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({ project, worktree: null, session, plugin, daemonPort: 0, cli: "claude" });

    const a = agent.enqueue({ message: "A" });
    agent.enqueue({ message: "B" });
    const c = agent.enqueue({ message: "C" });
    await waitFor(() => gatesReady() >= 1); // A running; queue [B, C]

    expect(agent.promoteQueuedTurn(c.turnId)).toBe("ok"); // aborts A, C jumps to front
    // Promote of a non-queued (active/unknown) turn → not_queued.
    expect(agent.promoteQueuedTurn("nope")).toBe("not_queued");

    // C runs next because A was preempted — NOT B (its queue neighbour).
    await waitFor(() => gatesReady() >= 2);
    expect(started).toEqual(["A", "C"]);

    // Gates are indexed by start order: gate 0 = A (already resolved by the
    // abort), gate 1 = C, gate 2 = B. Never release the aborted A's gate.
    release(1); // finish C
    await waitFor(() => gatesReady() >= 3);
    release(2); // finish B
    await agent.settled();
    expect(started).toEqual(["A", "C", "B"]); // A ran once (aborted), then C, then B

    // The preempted A ends with a terminal "Turn stopped" marker; no error card,
    // and it is not re-run (appears exactly once).
    const transcript = agent.readTranscript();
    const stopped = transcript.find((e) => e.kind === "status" && e.turnId === a.turnId);
    expect(stopped?.text).toBe("Turn stopped");
    expect(transcript.some((e) => e.kind === "error")).toBe(false);
    expect(started.filter((m) => m === "A")).toHaveLength(1);
  });

  // Send-now on the turn that is ALREADY at the front still preempts the active
  // turn — the reorder is a no-op but the interrupt is the whole point.
  it("promoteQueuedTurn on the only queued turn still preempts the active turn", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin, started, release, gatesReady } = makeGatePlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({ project, worktree: null, session, plugin, daemonPort: 0, cli: "claude" });

    const a = agent.enqueue({ message: "A" });
    const b = agent.enqueue({ message: "B" });
    await waitFor(() => gatesReady() >= 1); // A running; queue [B]

    expect(agent.promoteQueuedTurn(b.turnId)).toBe("ok"); // B already front; aborts A anyway
    await waitFor(() => gatesReady() >= 2);
    expect(started).toEqual(["A", "B"]);

    release(1); // finish B
    await agent.settled();
    const transcript = agent.readTranscript();
    expect(transcript.find((e) => e.kind === "status" && e.turnId === a.turnId)?.text).toBe("Turn stopped");
  });

  // Send-now jumps ahead of the whole queue and preempts — the skipped turns
  // keep their relative order behind it.
  it("promoteQueuedTurn jumps ahead of other queued turns and preempts", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin, started, release, gatesReady } = makeGatePlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({ project, worktree: null, session, plugin, daemonPort: 0, cli: "claude" });

    agent.enqueue({ message: "A" });
    agent.enqueue({ message: "B" });
    agent.enqueue({ message: "C" });
    const d = agent.enqueue({ message: "D" });
    await waitFor(() => gatesReady() >= 1); // A running; queue [B, C, D]

    expect(agent.promoteQueuedTurn(d.turnId)).toBe("ok"); // aborts A; queue [D, B, C]
    await waitFor(() => gatesReady() >= 2);
    expect(started).toEqual(["A", "D"]); // D runs next

    release(1); // finish D → B
    await waitFor(() => gatesReady() >= 3);
    release(2); // finish B → C
    await waitFor(() => gatesReady() >= 4);
    release(3); // finish C
    await agent.settled();
    expect(started).toEqual(["A", "D", "B", "C"]); // D preempts, then B before C
  });

  // The firstTurnDone guard: preempting the very first turn must NOT consume the
  // "first turn" flag — the CLI session was never established, so the promoted
  // turn has to run as turn 1 (carrying the system prompt), not a bare --resume.
  it("preempting turn 1 keeps the next turn as the first turn", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin, firstTurns, release, gatesReady } = makeGatePlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({ project, worktree: null, session, plugin, daemonPort: 0, cli: "claude" });

    agent.enqueue({ message: "A" }); // turn 1
    const b = agent.enqueue({ message: "B" });
    await waitFor(() => gatesReady() >= 1);
    expect(firstTurns[0]).toBe(true); // A is the first turn

    expect(agent.promoteQueuedTurn(b.turnId)).toBe("ok"); // aborts A before it produced a result
    await waitFor(() => gatesReady() >= 2);
    expect(firstTurns[1]).toBe(true); // B is STILL the first turn (A never established the session)

    release(1);
    await agent.settled();
  });

  // A5 — an abandoned edit (held turn) is cancellable, not a zombie.
  it("cancelQueuedTurn evicts a held (editing) turn", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin, started, release, gatesReady } = makeGatePlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({ project, worktree: null, session, plugin, daemonPort: 0, cli: "claude" });

    agent.enqueue({ message: "A" });
    const b = agent.enqueue({ message: "B" });
    await waitFor(() => gatesReady() >= 1);
    agent.beginEditQueuedTurn(b.turnId);
    expect(agent.getMeta().editingTurnIds).toEqual([b.turnId]);

    expect(agent.cancelQueuedTurn(b.turnId)).toBe(true); // held turn removed
    expect(agent.getMeta().editingTurnIds).toEqual([]);

    release(0);
    await agent.settled();
    expect(started).toEqual(["A"]); // B never ran
  });
});

describe("P4 — edit a sent message / fork", () => {
  let project: ProjectRecord;

  /** A plugin that records each turn's `ctx.forkFromChatId` + message, and emits a
   *  session_init whose agentChatId branches (`-forked`) on a fork turn. */
  function makeForkPlugin(): { plugin: AgentPlugin; forkFroms: (string | undefined)[]; messages: string[] } {
    const forkFroms: (string | undefined)[] = [];
    const messages: string[] = [];
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
      getForkCommand() {
        return ["--fork-session"];
      },
      supportsJson() {
        return true;
      },
      async *runTurn(input: TurnInput, ctx: TurnContext): AsyncIterable<NormalizedEvent> {
        forkFroms.push(ctx.forkFromChatId);
        messages.push(input.message);
        // A fork turn (--fork-session) mints a NEW harness session id.
        const chatId = ctx.forkFromChatId ? `${ctx.forkFromChatId}-forked` : "chat-1";
        const base = { sessionId: ctx.session.id, ts: new Date().toISOString(), provider: "claude" } as const;
        yield { ...base, id: `init-${messages.length}`, kind: "session_init", agentChatId: chatId } as NormalizedEvent;
        yield { ...base, id: `text-${messages.length}`, kind: "text", text: `answer ${input.message}` } as NormalizedEvent;
        yield { ...base, id: `result-${messages.length}`, kind: "result" } as NormalizedEvent;
      },
    } as unknown as AgentPlugin;
    return { plugin, forkFroms, messages };
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-jsonfork-"));
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    _clearStoreForTest();
    project = {
      id: PROJECT_ID,
      absolutePath: join(tempDir, "repo"),
      prefix: "pq",
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

  // P4.T2 (J6) — forking an answered turn supersedes it + everything after, re-runs
  // the edited message carrying forkFromChatId, and adopts the new forked chat id.
  it("forkTurn truncates at turn N, re-runs with --fork-session, adopts the forked id", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin, forkFroms, messages } = makeForkPlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({ project, worktree: null, session, plugin, daemonPort: 0, cli: "claude" });

    agent.enqueue({ message: "A" });
    await agent.settled();
    expect(session.agentChatId).toBe("chat-1"); // captured from turn-1 session_init
    const b = agent.enqueue({ message: "B" });
    await agent.settled();
    expect(forkFroms).toEqual([undefined, undefined]); // neither was a fork

    // Fork the SECOND (answered) turn with an edited message.
    const res = agent.forkTurn({ turnId: b.turnId, message: "B2" });
    expect(res).not.toBe("not_found");
    if (res === "not_found") throw new Error("unreachable");
    expect(res.supersededTurnIds).toContain(b.turnId);
    await agent.settled();

    // The fork turn ran forking off the ORIGINAL session id (→ --fork-session).
    expect(forkFroms[2]).toBe("chat-1");
    expect(messages[2]).toBe("B2");
    // Subsequent turns resume the FORKED branch, not the original.
    expect(session.agentChatId).toBe("chat-1-forked");

    // Superseded turn hidden from replay; the new branch head appears.
    const tr = agent.readTranscript();
    expect(tr.filter((e) => e.kind === "user").map((e) => e.text)).toEqual(["A", "B2"]);
    expect(tr.some((e) => e.turnId === b.turnId)).toBe(false); // turn 2 gone from live read
    expect(tr.some((e) => e.turnId === res.turnId)).toBe(true); // fork head present
  });

  it("forkTurn on an unknown turnId returns not_found (no truncation)", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin } = makeForkPlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({ project, worktree: null, session, plugin, daemonPort: 0, cli: "claude" });
    agent.enqueue({ message: "A" });
    await agent.settled();
    expect(agent.forkTurn({ turnId: "nope", message: "x" })).toBe("not_found");
    expect(agent.readTranscript().filter((e) => e.kind === "user")).toHaveLength(1);
  });

  // P4.T4 — a QUEUED-turn edit uses the `edited` path (same turnId, superseding
  // user event, NOTHING superseded) — distinct semantics from a fork.
  // (kept in P4 section, followed by Phase 5 suite below)
  it("editing a queued turn keeps the original visible (edited path ≠ fork)", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin, release, gatesReady } = makeGatePlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({ project, worktree: null, session, plugin, daemonPort: 0, cli: "claude" });

    agent.enqueue({ message: "A" });
    const b = agent.enqueue({ message: "B" });
    await waitFor(() => gatesReady() >= 1);
    agent.beginEditQueuedTurn(b.turnId);
    release(0);
    await agent.settled();
    expect(agent.resubmitQueuedTurn(b.turnId, { edited: true, message: "B2", attachments: [] })).toBe("ok");
    await waitFor(() => gatesReady() >= 2);
    release(1);
    await agent.settled();

    // BOTH user events for the same turnId survive (nothing superseded) — the
    // queued edit is a supersede-on-render `edited` flag, not a fork truncation.
    const users = agent.readTranscript().filter((e) => e.kind === "user" && e.turnId === b.turnId);
    expect(users.map((e) => e.text)).toEqual(["B", "B2"]);
    expect(users[1]!.edited).toBe(true);
    expect(users.every((e) => e.superseded !== true)).toBe(true);
  });
});

describe("Phase 5 — submit() steer-vs-enqueue gate", () => {
  let project: ProjectRecord;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-submit-"));
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    _clearStoreForTest();
    project = {
      id: PROJECT_ID,
      absolutePath: join(tempDir, "repo"),
      prefix: "pq",
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

  // 5.T3 — submit() when NOT running: falls through to enqueue(), delivery: "queued"
  it("5.T3 — submit() when not running falls through to enqueue, delivery: queued", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin, release, gatesReady } = makeGatePlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({ project, worktree: null, session, plugin, daemonPort: 0, cli: "claude" });

    // Not running — no turns started
    const result = await agent.submit({ message: "hello" });
    expect(result.delivery).toBe("queued");
    expect(result.queuePosition).toBe(0);

    await waitFor(() => gatesReady() >= 1);
    release(0);
    await agent.settled();
    void release;
  });

  // 5.T4 — submit() when running + attachments: falls through to enqueue (attachment gate)
  it("5.T4 — submit() when running with attachments falls through to enqueue, delivery: queued", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin, release, gatesReady } = makeGatePlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({ project, worktree: null, session, plugin, daemonPort: 0, cli: "claude" });

    agent.enqueue({ message: "A" });
    await waitFor(() => gatesReady() >= 1); // A is running

    // Has attachments — must NOT steer even if connection would support it
    const result = await agent.submit({
      message: "with attachment",
      attachments: [{ id: "att-1", name: "file.txt", size: 100, mimeType: "text/plain" }],
    });
    expect(result.delivery).toBe("queued");
    expect(result.queuePosition).toBe(1); // queued behind A

    release(0);
    await waitFor(() => gatesReady() >= 2);
    release(1);
    await agent.settled();
  });

  // 5.T5 — inject fake connection that returns "injected"; test: steered delivery
  it("5.T5 — submit() with steering-capable connection injects mid-turn, delivery: steered", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin, release, gatesReady } = makeGatePlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({ project, worktree: null, session, plugin, daemonPort: 0, cli: "claude" });

    // Complete turn 1 so isFirstTurnPending becomes false
    agent.enqueue({ message: "A" });
    await waitFor(() => gatesReady() >= 1);
    release(0);
    await agent.settled();

    // Enqueue turn 2 and let it start running
    agent.enqueue({ message: "B" });
    await waitFor(() => gatesReady() >= 2); // B is now running

    // Inject a fake connection that claims alive + supportsSteering + returns "injected"
    const fakeConn = {
      isAlive: () => true,
      supportsSteering: true,
      steer: async (_blocks: unknown[]) => "injected" as const,
    };
    (agent as unknown as { connection: unknown }).connection = fakeConn;

    const transcriptBefore = agent.readTranscript().filter((e) => e.kind === "user").length;

    const result = await agent.submit({ message: "steer!" });
    expect(result.delivery).toBe("steered");
    expect(result.queuePosition).toBe(0);

    // emitUserEvent was called — transcript gains one more user event
    const transcriptAfter = agent.readTranscript().filter((e) => e.kind === "user").length;
    expect(transcriptAfter).toBe(transcriptBefore + 1);

    // Queue is untouched (no new item enqueued)
    expect(agent.getMeta().queueDepth).toBe(0);

    release(1);
    await agent.settled();
  });

  // 5.T7 — a plugin that does NOT declare supportsMidTurnSteering never steers,
  // even when the connection advertises steering and would answer "injected".
  // This is the opencode case: it claims the capability and acknowledges the
  // request, but the injected text never reaches the model, so queueing (which
  // is lossless) is the only correct behaviour.
  it("5.T7 — plugin without supportsMidTurnSteering always enqueues, never steers", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin, release, gatesReady } = makeGatePlugin();
    // Drop the claude-only opt-in → stands in for opencode/cursor.
    delete (plugin as { supportsMidTurnSteering?: () => boolean }).supportsMidTurnSteering;
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({ project, worktree: null, session, plugin, daemonPort: 0, cli: "opencode" });

    agent.enqueue({ message: "A" });
    await waitFor(() => gatesReady() >= 1);
    release(0);
    await agent.settled();

    agent.enqueue({ message: "B" });
    await waitFor(() => gatesReady() >= 2); // B running

    let steerCalls = 0;
    const fakeConn = {
      isAlive: () => true,
      supportsSteering: true,
      steer: async (_blocks: unknown[]) => {
        steerCalls++;
        return "injected" as const;
      },
    };
    (agent as unknown as { connection: unknown }).connection = fakeConn;

    // The meta flag the composer reads must also be false, so the UI never
    // promises steering for a CLI that cannot honour it.
    expect(agent.getMeta().canSteer).toBe(false);

    const result = await agent.submit({ message: "no steering please" });
    expect(result.delivery).toBe("queued");
    expect(result.queuePosition).toBe(1);
    expect(steerCalls).toBe(0);

    release(1);
    await waitFor(() => gatesReady() >= 3);
    release(2);
    await agent.settled();
  });

  // 5.T6 — same setup but fake returns "promptRequired" → falls through to enqueue
  it("5.T6 — submit() with promptRequired falls through to enqueue, delivery: queued", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { plugin, release, gatesReady } = makeGatePlugin();
    const session = project.directSessions[0]!;
    const agent = new JsonAgentSession({ project, worktree: null, session, plugin, daemonPort: 0, cli: "claude" });

    // Complete turn 1 so isFirstTurnPending becomes false
    agent.enqueue({ message: "A" });
    await waitFor(() => gatesReady() >= 1);
    release(0);
    await agent.settled();

    // Enqueue turn 2 and let it start running
    agent.enqueue({ message: "B" });
    await waitFor(() => gatesReady() >= 2); // B is now running

    const userEventsBefore = agent.readTranscript().filter((e) => e.kind === "user").length;

    // Fake returns "promptRequired" — should fall through to enqueue
    const fakeConn = {
      isAlive: () => true,
      supportsSteering: true,
      steer: async (_blocks: unknown[]) => "promptRequired" as const,
    };
    (agent as unknown as { connection: unknown }).connection = fakeConn;

    const result = await agent.submit({ message: "fallback" });
    expect(result.delivery).toBe("queued");
    expect(result.queuePosition).toBe(1); // queued behind B

    // emitUserEvent called by enqueue (not by the steer path)
    const userEventsAfter = agent.readTranscript().filter((e) => e.kind === "user").length;
    expect(userEventsAfter).toBe(userEventsBefore + 1);

    release(1);
    await waitFor(() => gatesReady() >= 3);
    release(2);
    await agent.settled();
  });
});
