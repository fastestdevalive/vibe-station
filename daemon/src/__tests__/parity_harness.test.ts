import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the daemon's home to a temp dir (established daemon-test pattern —
// see sessions.test.ts / project-store.test.ts). The real ~/.vibe-station is
// never touched: vstHome()/dbPath() resolve under this temp dir, so the SQLite
// DB, modes.json, config.json all live there.
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

// Mock tmux/spawn so boot doesn't need a real tmux server or spawn agents.
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

import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";

interface Fixture {
  method: string;
  url: string;
  statusCode: number;
  body: string;
}

// The read-only, deterministic fixture set driven through BOTH daemons. These
// routes need no live agent, tmux server, or network. Each is run against a
// FRESH, empty store on both sides so the responses are byte-comparable.
// `POST /sessions/:id/chat/fork` is F1's ONE documented exception: the
// edit-a-sent-message/fork path was dropped from the Rust daemon entirely
// (part 07a, commit d151c71), so it is asserted as gone (404) on the Rust
// side rather than byte-compared. It is captured here only to document that
// the NODE daemon still exposes the route (it is expected NOT to be 405).
//
// Routes that are environment-dependent are deliberately EXCLUDED from the
// byte-for-byte diff and asserted only for structural equality instead:
//   - GET /settings — reflects the real user home (homeDir / defaultProjectsDir).
//   - GET /tailscale/status — embeds the machine's actual tailnet hostname.
// Both daemons build with noAuth so GET /auth/check is byte-comparable.
const FIXTURE_REQUESTS: Array<{ method: string; url: string }> = [
  { method: "GET", url: "/modes" },
  { method: "GET", url: "/sessions" },
  { method: "GET", url: "/worktrees" },
  { method: "GET", url: "/projects" },
  { method: "GET", url: "/supported-clis" },
  { method: "GET", url: "/skills" },
  { method: "GET", url: "/auth/check" },
  { method: "GET", url: "/user/ordered-lists/pinned-all" },
  { method: "GET", url: "/auth/tunnel/status" },
  // F1 exception: route present in Node (not 405) but removed in Rust.
  { method: "POST", url: "/sessions/nonexistent/chat/fork" },
];

describe("parity harness (node side)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-parity-node-"));
    const { _clearStoreForTest } = await import("../state/project-store.js");
    _clearStoreForTest();
    app = await buildServer({ noAuth: true });
  });

  afterAll(async () => {
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("captures deterministic responses for the parity fixture set", async () => {
    const fixtures: Fixture[] = [];
    for (const req of FIXTURE_REQUESTS) {
      const res = await app.inject({ method: req.method as "GET" | "POST", url: req.url });
      fixtures.push({
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        body: res.body,
      });
    }

    // F1 exception sanity: the fork route still EXISTS on the Node side, so it
    // must NOT be a 405 (method-not-allowed) — that would mean the route was
    // removed, contradicting "Node still has it". (The exact status for a
    // nonexistent session id — 400/404 — is not the point; route PRESENCE is.)
    // The complementary assertion that the route is GONE (404/405) on the Rust
    // side lives in the Rust parity harness, not here.
    const fork = fixtures.find((f) => f.url.endsWith("/chat/fork"));
    expect(fork).toBeDefined();
    expect(fork!.statusCode).not.toBe(405);

    // Dump the fixtures to a committed baseline file for the Rust parity test
    // to diff against, when PARITY_FIXTURE_OUT is set (regeneration workflow).
    const outPath = process.env.PARITY_FIXTURE_OUT;
    if (outPath) {
      await writeFile(outPath, JSON.stringify(fixtures, null, 2), "utf8");
    }
  });
});
