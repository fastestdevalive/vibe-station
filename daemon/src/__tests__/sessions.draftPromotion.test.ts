import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import * as broadcasterNs from "../broadcaster.js";

let tempDir: string;

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  return {
    vstHome: () => tempDir,
    projectDir: (id: string) => pathJoin(tempDir, "projects", id),
    manifestPath: (id: string) => pathJoin(tempDir, "projects", id, "manifest.json"),
    manifestTmpPath: (id: string) => pathJoin(tempDir, "projects", id, "manifest.json.tmp"),
    worktreePath: (id: string, wtId: string) => pathJoin(tempDir, "projects", id, "worktrees", wtId),
    configPath: () => pathJoin(tempDir, "config.json"),
    modesPath: () => pathJoin(tempDir, "modes.json"),
    daemonLogPath: () => pathJoin(tempDir, "logs", "daemon.log"),
    dbPath: () => pathJoin(tempDir, "vibe-station.db"),
    cleanupSessionDataDir: () => {},
    cleanupDirectSessionDataDir: () => {},
    sessionDataDir: (p: string, w: string, s: string) =>
      pathJoin(tempDir, "projects", p, "session-data", w, s),
    directSessionDataDir: (p: string, s: string) => pathJoin(tempDir, "projects", p, "sessions", s),
  };
});

vi.mock("../services/spawn.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/spawn.js")>();
  return {
    ...original,
    spawnSession: vi.fn(async () => {}),
    spawnDirectSession: vi.fn(async () => {}),
  };
});

vi.mock("../services/tmux.js", () => ({
  newSession: vi.fn().mockResolvedValue(undefined),
  hasSession: vi.fn().mockResolvedValue(true),
  killSession: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(""),
  pasteBuffer: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  listSessionNames: vi.fn().mockResolvedValue(new Set()),
  listSessions: vi.fn().mockResolvedValue([]),
}));

vi.mock("../broadcaster.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../broadcaster.js")>();
  return {
    ...original,
    broadcastAll: vi.fn(),
  };
});

/**
 * Coverage for `POST /sessions/:id/start`'s draft-promotion broadcasts.
 *
 * A drafting session is promoted to `not_started` and moved into a worktree.
 * The "brand-new worktree" branch (entryPoint "worktree"/worktreeChoice "new")
 * already broadcast `worktree:created` + `session:updated { worktreeId }` +
 * `session:state`. The "existing worktree" branch (entryPoint "worktree"/
 * worktreeChoice "existing", or entryPoint "tab") used to broadcast only
 * `session:state`, so other clients never received the session's `worktreeId`
 * update live. 1.T1 locks in that the existing-worktree branch now also
 * broadcasts `session:updated { worktreeId }`; 1.T2 locks in that the
 * new-worktree branch's broadcasts are unchanged.
 */
describe("POST /sessions/:id/start — draft-promotion broadcasts", () => {
  let app: FastifyInstance;
  let repoDir: string;
  let projectId: string;
  let worktreeId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-draft-promotion-"));
    repoDir = join(tempDir, "repo");
    execSync(`mkdir -p "${repoDir}" && git init "${repoDir}" && git -C "${repoDir}" commit --allow-empty -m init`, {
      stdio: "ignore",
    });

    await writeFile(
      join(tempDir, "modes.json"),
      JSON.stringify([
        { id: "bug-fix", name: "Bug Fix", cli: "claude", context: "fix bugs", createdAt: new Date().toISOString() },
      ]),
    );
    const modesModule = await import("../routes/modes.js");
    modesModule._resetModesCacheForTest();

    const { _clearStoreForTest } = await import("../state/project-store.js");
    _clearStoreForTest();

    app = await buildServer();

    const projRes = await app.inject({ method: "POST", url: "/projects", payload: { path: repoDir } });
    projectId = projRes.json<{ id: string }>().id;

    const wtRes = await app.inject({
      method: "POST",
      url: "/worktrees",
      payload: { projectId, branch: "draft-promotion-target", modeId: "bug-fix" },
    });
    const wt = wtRes.json<{ id: string }>();
    worktreeId = wt.id;

    vi.mocked(broadcasterNs.broadcastAll).mockClear();
  });

  afterEach(async () => {
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function createDirectDraft(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { target: "direct", projectId, type: "agent", state: "drafting" },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  async function createTabDraft(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { target: "worktree", worktreeId, type: "agent", state: "drafting" },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  it("1.T1 — a direct draft promoted into an EXISTING worktree broadcasts session:updated { worktreeId } in addition to session:state", async () => {
    // Uses entryPoint "worktree"/worktreeChoice "existing" (a direct draft
    // choosing an already-existing worktree at start time) rather than
    // entryPoint "tab" — a tab draft already lives inside that worktree's
    // `sessions[]`, and promoting it hits a separate, pre-existing duplicate-
    // session bug (the draft is never removed from the worktree's sessions
    // before the updated record is appended) that is out of scope for this
    // plan. This still exercises the exact `existingWorktree` branch (and
    // its new `session:updated { worktreeId }` broadcast, 1.1) that 1.T1
    // targets, without tripping over that unrelated bug.
    const draftId = await createDirectDraft();
    vi.mocked(broadcasterNs.broadcastAll).mockClear();

    const res = await app.inject({
      method: "POST",
      url: `/sessions/${draftId}/start`,
      payload: {
        draftPrompt: "fix the thing",
        draftConfig: {
          entryPoint: "worktree",
          worktreeChoice: "existing",
          existingWorktreeId: worktreeId,
          modeId: "bug-fix",
          channel: "json",
        },
        skipAutoTurn: true,
      },
    });
    expect(res.statusCode).toBe(200);
    // The HTTP response itself must report the worktreeId too — the web-ui
    // navigates off this response synchronously (before the WS broadcast
    // above necessarily lands), and previously fell back to `undefined` here,
    // which routed the just-started agent to the direct-session `/session/:id`
    // URL instead of `/worktree/:id` (issue: tab/existing-worktree draft
    // landing on the wrong URL after Start).
    expect(res.json()).toMatchObject({ ok: true, worktreeId });

    const broadcastAll = vi.mocked(broadcasterNs.broadcastAll);
    const updatedCall = broadcastAll.mock.calls.find(
      ([msg]) => (msg as { type: string }).type === "session:updated",
    );
    expect(updatedCall).toBeDefined();
    expect(updatedCall![0]).toMatchObject({
      type: "session:updated",
      sessionId: draftId,
      worktreeId,
    });

    const stateCall = broadcastAll.mock.calls.find(
      ([msg]) => (msg as { type: string }).type === "session:state" && (msg as { sessionId: string }).sessionId === draftId,
    );
    expect(stateCall).toBeDefined();
    expect(stateCall![0]).toMatchObject({ type: "session:state", sessionId: draftId, state: "not_started" });
  });

  it("1.T3 — an entryPoint \"tab\" draft (already inside a worktree) reports worktreeId in the HTTP response and does not duplicate itself in the worktree's sessions", async () => {
    const draftId = await createTabDraft();
    vi.mocked(broadcasterNs.broadcastAll).mockClear();

    const res = await app.inject({
      method: "POST",
      url: `/sessions/${draftId}/start`,
      payload: {
        draftPrompt: "fix the thing from the agent tab",
        draftConfig: { entryPoint: "tab", modeId: "bug-fix", channel: "json" },
        skipAutoTurn: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, worktreeId });

    const sessRes = await app.inject({ method: "GET", url: `/sessions?worktree=${worktreeId}` });
    const sessionsInWorktree = sessRes.json<Array<{ id: string }>>();
    expect(sessionsInWorktree.filter((s) => s.id === draftId)).toHaveLength(1);
  });

  it("1.T2 — a draft promoted into a BRAND-NEW worktree still broadcasts worktree:created + session:updated { worktreeId } + session:state (unchanged)", async () => {
    const draftId = await createDirectDraft();
    vi.mocked(broadcasterNs.broadcastAll).mockClear();

    const res = await app.inject({
      method: "POST",
      url: `/sessions/${draftId}/start`,
      payload: {
        draftPrompt: "spin up a fresh worktree",
        draftConfig: {
          entryPoint: "worktree",
          worktreeChoice: "new",
          modeId: "bug-fix",
          channel: "json",
          branch: "draft-new-branch",
          baseBranch: "main",
        },
        skipAutoTurn: true,
      },
    });
    expect(res.statusCode).toBe(200);
    // The HTTP response must also carry the full serialized worktree, not
    // just its id — the web-ui registers it in the store synchronously off
    // this response (DraftComposer.startTier1's `applyWorktreeCreated` call),
    // rather than depending on the `worktree:created` broadcast below racing
    // its own navigation (issue: new-worktree draft sometimes staying blank
    // until a page refresh). `mainSessionId` must resolve to the real
    // promoted session, not null — `newWorktree` was built with an empty
    // `sessions: []` and needs the promoted session merged in before
    // serializing, which is the same fix this response and the broadcast
    // below both needed.
    const body = res.json<{ ok: true; worktreeId: string; worktree: { id: string; mainSessionId: string | null } }>();
    expect(body.worktree).toBeDefined();
    expect(body.worktree.id).toBe(body.worktreeId);
    expect(body.worktree.mainSessionId).toBe(draftId);

    const broadcastAll = vi.mocked(broadcasterNs.broadcastAll);
    const worktreeCreated = broadcastAll.mock.calls.find(
      ([msg]) => (msg as { type: string }).type === "worktree:created",
    );
    expect(worktreeCreated).toBeDefined();
    expect((worktreeCreated![0] as { worktree: { mainSessionId: string | null } }).worktree.mainSessionId).toBe(
      draftId,
    );

    const updatedCall = broadcastAll.mock.calls.find(
      ([msg]) => (msg as { type: string }).type === "session:updated",
    );
    expect(updatedCall).toBeDefined();
    expect(updatedCall![0]).toMatchObject({
      type: "session:updated",
      sessionId: draftId,
      worktreeId: expect.any(String),
    });
    const newWorktreeId = (updatedCall![0] as { worktreeId: string }).worktreeId;
    expect(newWorktreeId).not.toBe(worktreeId);

    const stateCall = broadcastAll.mock.calls.find(
      ([msg]) => (msg as { type: string }).type === "session:state" && (msg as { sessionId: string }).sessionId === draftId,
    );
    expect(stateCall).toBeDefined();
    expect(stateCall![0]).toMatchObject({ type: "session:state", sessionId: draftId, state: "not_started" });
  });
});
