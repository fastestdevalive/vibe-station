import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import type { ProjectRecord, WorktreeRecord, SessionRecord } from "../types.js";

let tempDir: string;

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  return {
    vstHome: () => tempDir,
    projectDir: (id: string) => pathJoin(tempDir, "projects", id),
    manifestPath: (id: string) => pathJoin(tempDir, "projects", id, "manifest.json"),
    manifestTmpPath: (id: string) => pathJoin(tempDir, "projects", id, "manifest.json.tmp"),
    worktreePath: (id: string, wtId: string) =>
      pathJoin(tempDir, "projects", id, "worktrees", wtId),
    configPath: () => pathJoin(tempDir, "config.json"),
    modesPath: () => pathJoin(tempDir, "modes.json"),
    daemonLogPath: () => pathJoin(tempDir, "logs", "daemon.log"),
    dbPath: () => pathJoin(tempDir, "vibe-station.db"),
    cleanupSessionDataDir: () => {},
    cleanupDirectSessionDataDir: () => {},
    sessionDataDir: (p: string, w: string, s: string) =>
      pathJoin(tempDir, "projects", p, "session-data", w, s),
    directSessionDataDir: (p: string, s: string) =>
      pathJoin(tempDir, "projects", p, "sessions", s),
  };
});

vi.mock("../services/tmux.js", () => ({
  hasSession: vi.fn().mockResolvedValue(false),
  killSession: vi.fn().mockResolvedValue(undefined),
  newSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(""),
  listSessions: vi.fn().mockResolvedValue([]),
  pasteBuffer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/spawn.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/spawn.js")>();
  return {
    ...original,
    spawnSession: vi.fn(async () => {}),
    spawnSessionFromArgv: vi.fn(async () => {}),
    spawnDirectSession: vi.fn(async () => {}),
  };
});

vi.mock("../services/jsonAgentChat.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/jsonAgentChat.js")>();
  return {
    ...original,
    startJsonCreateTurn: vi.fn(async () => {}),
  };
});

describe("Session routes — parentSessionId (subagent-ux-v2 Phase 1)", () => {
  let app: FastifyInstance;
  let projectId: string;
  let worktreeId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-sess-parent-test-"));
    const repoDir = join(tempDir, "my-repo");
    execSync(
      `mkdir -p "${repoDir}" && git init "${repoDir}" && git -C "${repoDir}" commit --allow-empty -m "init"`,
      { stdio: "ignore" },
    );

    const { _clearStoreForTest } = await import("../state/project-store.js");
    _clearStoreForTest();

    await writeFile(
      join(tempDir, "modes.json"),
      JSON.stringify([
        {
          id: "bugfix",
          name: "Bug Fix",
          cli: "claude",
          context: "You are a bug fix expert",
          createdAt: new Date().toISOString(),
        },
      ]),
    );

    const modesModule = await import("../routes/modes.js");
    modesModule._resetModesCacheForTest();

    const promptBuilderModule = await import("../services/promptBuilder.js");
    promptBuilderModule._resetSkillCacheForTest();

    app = await buildServer();

    const projRes = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { path: repoDir },
    });
    projectId = projRes.json<ProjectRecord>().id;

    const wtRes = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "feat-sessions", modeId: "bugfix" },
    });
    worktreeId = wtRes.json<WorktreeRecord>().id;
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 150));
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("1.T4 — resetting a session with parentSessionId set yields a new record with the same value", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix", sourceAgentId: "sess-original-parent" },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json<{ id: string; parentSessionId: string | null }>();
    expect(created.parentSessionId).toBe("sess-original-parent");

    const resetRes = await app.inject({
      method: "POST",
      url: `/sessions/${created.id}/reset`,
      payload: {},
    });
    expect(resetRes.statusCode).toBe(200);
    const { newSessionId } = resetRes.json<{ newSessionId: string }>();

    const getRes = await app.inject({ method: "GET", url: `/sessions/${newSessionId}` });
    expect(getRes.json<{ parentSessionId: string | null }>().parentSessionId).toBe("sess-original-parent");
  });

  it("1.T5 — sourceAgentId pointing at a json-channel session with no modeId/channel creates a json child with the parent's mode", async () => {
    const parentRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix", channel: "json" },
    });
    expect(parentRes.statusCode).toBe(201);
    const parent = parentRes.json<{ id: string; channel: string; modeId: string }>();
    expect(parent.channel).toBe("json");

    const childRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", sourceAgentId: parent.id },
    });
    expect(childRes.statusCode).toBe(201);
    const child = childRes.json<{ channel: string; modeId: string; parentSessionId: string | null }>();
    expect(child.channel).toBe("json");
    expect(child.modeId).toBe(parent.modeId);
    expect(child.parentSessionId).toBe(parent.id);
  });

  it("1.T5b — an inherited pty channel keeps useTmux consistent with it (review HIGH-1)", async () => {
    // `useTmux` and `channel` must agree: spawnSession branches on useTmux
    // while every read path goes through sessionChannel(session), and
    // normalizeChannel only repairs the json case — so a {channel:"pty",
    // useTmux:true} row spawns tmux forever while the UI drives direct-PTY.
    const parentRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix", channel: "pty" },
    });
    expect(parentRes.statusCode).toBe(201);
    const parent = parentRes.json<{ id: string; channel: string; useTmux: boolean }>();
    expect(parent.channel).toBe("pty");
    expect(parent.useTmux).toBe(false); // explicit pty must not leave useTmux true

    const childRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", sourceAgentId: parent.id },
    });
    expect(childRes.statusCode).toBe(201);
    const child = childRes.json<{ channel: string; useTmux: boolean }>();
    expect(child.channel).toBe("pty");
    expect(child.useTmux).toBe(false); // inherited pty must not flip useTmux back on
  });

  it("1.T5c — an inherited tmux channel still yields useTmux true", async () => {
    const parentRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix", channel: "tmux" },
    });
    const parent = parentRes.json<{ id: string; channel: string; useTmux: boolean }>();
    expect(parent.channel).toBe("tmux");
    expect(parent.useTmux).toBe(true);

    const childRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", sourceAgentId: parent.id },
    });
    const child = childRes.json<{ channel: string; useTmux: boolean }>();
    expect(child.channel).toBe("tmux");
    expect(child.useTmux).toBe(true);
  });

  it("1.T12 — /output serves a json session's transcript, with turns separated (review regression)", async () => {
    // A json session has no tmux pane and no direct-PTY stream, so before the
    // json branch this returned 200 with output:"" — a parent agent reading
    // its subagent's work saw nothing. Every Rich Chat subagent is json.
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix", channel: "json" },
    });
    const s = res.json<{ id: string; channel: string }>();
    expect(s.channel).toBe("json");

    // Seed a real transcript: two turns, each streamed as two chunks. An
    // empty transcript would make this test vacuous — the PRE-fix code also
    // answered 200 with a string for that input.
    const { openSqliteTranscriptStore } = await import("../services/sqliteTranscriptStore.js");
    const { sessionDataDirFor, findJsonSessionContext } = await import("../services/jsonAgentChat.js");
    const jsonCtx = findJsonSessionContext(s.id)!;
    const store = openSqliteTranscriptStore(sessionDataDirFor(jsonCtx), s.id);
    const ev = (id: string, turnId: string, text: string) =>
      ({ id, sessionId: s.id, ts: new Date().toISOString(), kind: "text", text, turnId }) as never;
    store.append(ev("e1", "t1", "first "));
    store.append(ev("e2", "t1", "answer."));
    store.append(ev("e3", "t2", "second "));
    store.append(ev("e4", "t2", "answer."));
    store.close?.();

    const out = await app.inject({ method: "GET", url: `/sessions/${s.id}/output` });
    expect(out.statusCode).toBe(200);
    const output = out.json<{ output: string }>().output;
    // Chunks within a turn concatenate bare; separate turns must NOT weld
    // together ("...next steps.The subagent finished...").
    expect(output).toContain("first answer.");
    expect(output).toContain("second answer.");
    expect(output).toBe("first answer.\n\nsecond answer.");
  });

  it("1.T6 — no sourceAgentId and no modeId still 400s with 'modeId is required for agent sessions' (regression)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("'modeId' is required for agent sessions");
  });

  it("1.T9 — the invariant: a child's parentSessionId equals the parent's VST_SESSION (its own id)", async () => {
    const parentRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix" },
    });
    const parent = parentRes.json<{ id: string }>();

    const childRes = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { worktreeId, type: "agent", modeId: "bugfix", sourceAgentId: parent.id },
    });
    const child = childRes.json<{ parentSessionId: string | null }>();
    // parent.VST_SESSION === parent.id (buildVstEnv sets VST_SESSION: session.id)
    expect(child.parentSessionId).toBe(parent.id);
  });
});
