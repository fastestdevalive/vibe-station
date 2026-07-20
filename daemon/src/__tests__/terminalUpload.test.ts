/**
 * json-mode-followups item 3 — terminal-mode file upload (Phase 3 verify).
 *
 * Exercises the daemon-side pieces end-to-end at the route + filesystem level:
 * POST /sessions/:id/attachments (relaxed channel gate + pending-uploads
 * reference write), the vibe-uploads.sh hook script itself (spawned for real,
 * not mocked), and the new DELETE route.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ProjectRecord, WorktreeRecord, SessionRecord } from "../types.js";

const execFileAsync = promisify(execFile);

let tempDir: string;

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  const { rmSync } = await import("node:fs");
  const base = () => tempDir;
  const directDataDir = (p: string, s: string) => pathJoin(base(), "projects", p, "sessions", s);
  const wtDataDir = (p: string, w: string, s: string) => pathJoin(base(), "projects", p, "session-data", w, s);
  return {
    vstHome: () => base(),
    projectDir: (id: string) => pathJoin(base(), "projects", id),
    manifestPath: (id: string) => pathJoin(base(), "projects", id, "manifest.json"),
    manifestTmpPath: (id: string) => pathJoin(base(), "projects", id, "manifest.json.tmp"),
    worktreePath: (id: string, wtId: string) => pathJoin(base(), "projects", id, "worktrees", wtId),
    configPath: () => pathJoin(base(), "config.json"),
    modesPath: () => pathJoin(base(), "modes.json"),
    daemonLogPath: () => pathJoin(base(), "logs", "daemon.log"),
    sessionDataDir: wtDataDir,
    directSessionDataDir: directDataDir,
    systemPromptPath: (p: string, w: string, s: string) => pathJoin(wtDataDir(p, w, s), "system-prompt.md"),
    directSystemPromptPath: (p: string, s: string) => pathJoin(directDataDir(p, s), "system-prompt.md"),
    cleanupSessionDataDir: (p: string, w: string, s: string) =>
      rmSync(wtDataDir(p, w, s), { recursive: true, force: true }),
    cleanupDirectSessionDataDir: (p: string, s: string) =>
      rmSync(directDataDir(p, s), { recursive: true, force: true }),
  };
});

const PROJECT_ID = "proj-tup";
const WT_ID = `${PROJECT_ID}-w1`;
const WT_SESSION_ID = `${WT_ID}-a1`; // worktree agent, terminal (pty) channel, claude
const DIRECT_SESSION_ID = `${PROJECT_ID}-d1`; // direct agent, terminal (pty) channel, claude

let app: FastifyInstance;
let port: number;

function uploadBody(boundary: string, filename: string, contents: string): string {
  return (
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="files"; filename="${filename}"\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `${contents}\r\n` +
    `--${boundary}--\r\n`
  );
}

async function upload(sessionId: string, filename: string, contents = "hello"): Promise<{ id: string; name: string; path: string }> {
  const boundary = `----vst${Math.random().toString(36).slice(2)}`;
  const res = await app.inject({
    method: "POST",
    url: `/sessions/${sessionId}/attachments`,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: uploadBody(boundary, filename, contents),
  });
  expect(res.statusCode).toBe(201);
  const { attachments } = res.json<{ attachments: Array<{ id: string; name: string; path: string }> }>();
  return attachments[0]!;
}

function worktreePathFor(): string {
  return join(tempDir, "projects", PROJECT_ID, "worktrees", WT_ID);
}
function directPathFor(): string {
  return join(tempDir, "repo-direct");
}
function pendingUploadsDir(checkoutPath: string, sessionId: string): string {
  return join(checkoutPath, ".vibe-station", "pending-uploads", sessionId);
}

function worktreeSession(): SessionRecord {
  return {
    id: WT_SESSION_ID,
    slot: "a1",
    type: "agent",
    modeId: "m",
    tmuxName: `vst-${WT_SESSION_ID}`,
    useTmux: false,
    channel: "pty",
    lifecycle: { state: "not_started", lastTransitionAt: new Date().toISOString() },
  };
}
function directSession(): SessionRecord {
  return {
    id: DIRECT_SESSION_ID,
    slot: "d1",
    type: "agent",
    modeId: "m",
    tmuxName: `vst-${DIRECT_SESSION_ID}`,
    useTmux: false,
    channel: "pty",
    lifecycle: { state: "not_started", lastTransitionAt: new Date().toISOString() },
  };
}
function worktreeRecord(): WorktreeRecord {
  return {
    id: WT_ID,
    branch: "feat",
    baseBranch: "main",
    createdAt: new Date().toISOString(),
    sessions: [worktreeSession()],
  } as WorktreeRecord;
}

describe("json-mode-followups item 3 — terminal-mode file upload", () => {
  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-terminal-upload-"));
    await mkdir(join(tempDir, "projects", PROJECT_ID), { recursive: true });
    await mkdir(directPathFor(), { recursive: true });
    await writeFile(
      join(tempDir, "modes.json"),
      JSON.stringify([{ id: "m", name: "Test", cli: "claude", context: "ctx", createdAt: new Date().toISOString() }]),
    );

    // `project.absolutePath` (used for the direct session's pending-uploads
    // root) intentionally points at a DIFFERENT real dir than the mocked
    // `directSessionDataDir` used for staged uploads — mirrors production
    // (uploads live under ~/.vibe-station/, pending-uploads refs live in the
    // checkout).
    const { buildServer } = await import("../server.js");
    app = await buildServer({ logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    const { _clearAttachmentsForTest } = await import("../state/attachmentRegistry.js");
    _clearAttachmentsForTest();
    _clearStoreForTest();
    await addProject({
      id: PROJECT_ID,
      absolutePath: directPathFor(),
      prefix: "pt",
      isGit: true,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      directSessions: [directSession()],
      worktrees: [worktreeRecord()],
    } as ProjectRecord);
  });

  afterEach(async () => {
    await rm(pendingUploadsDir(worktreePathFor(), WT_SESSION_ID), { recursive: true, force: true });
    await rm(pendingUploadsDir(directPathFor(), DIRECT_SESSION_ID), { recursive: true, force: true });
  });

  it("3.T1 — upload writes exactly one pending-uploads reference file, content = staged abs path", async () => {
    const att = await upload(WT_SESSION_ID, "notes.txt");
    const dir = pendingUploadsDir(worktreePathFor(), WT_SESSION_ID);
    const entries = await readdir(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBe(`${att.id}-notes.txt`);
    const refContent = await readFile(join(dir, entries[0]!), "utf8");
    expect(refContent).toBe(att.path);
    expect(existsSync(att.path)).toBe(true);
  });

  it("3.T2 — hook script: 2 pending files → prints both paths, dir empty after", async () => {
    const { createClaudePlugin } = await import("../agent-plugins/claude.js");
    const plugin = createClaudePlugin();
    const wtPath = worktreePathFor();
    await plugin.setupWorkspaceHooks!(wtPath);

    const a = await upload(WT_SESSION_ID, "a.txt");
    const b = await upload(WT_SESSION_ID, "b.txt");

    const scriptPath = join(wtPath, ".claude", "vibe-uploads.sh");
    const { stdout } = await execFileAsync("bash", [scriptPath], {
      cwd: wtPath,
      env: { ...process.env, VST_SPAWN_TOKEN: WT_SESSION_ID, CLAUDE_PROJECT_DIR: wtPath },
    });
    expect(stdout).toContain(a.path);
    expect(stdout).toContain(b.path);

    const dir = pendingUploadsDir(wtPath, WT_SESSION_ID);
    const entries = await readdir(dir);
    expect(entries).toHaveLength(0);
  });

  it("3.T2b — hook script is a no-op (exit 0, no output) when nothing is pending", async () => {
    const { createClaudePlugin } = await import("../agent-plugins/claude.js");
    const plugin = createClaudePlugin();
    const wtPath = worktreePathFor();
    await plugin.setupWorkspaceHooks!(wtPath);
    const scriptPath = join(wtPath, ".claude", "vibe-uploads.sh");
    const { stdout } = await execFileAsync("bash", [scriptPath], {
      cwd: wtPath,
      env: { ...process.env, VST_SPAWN_TOKEN: "some-other-session", CLAUDE_PROJECT_DIR: wtPath },
    });
    expect(stdout.trim()).toBe("");
  });

  it("3.T3 — DELETE removes both the staged file and the pending reference; second delete is a no-op, not a 500", async () => {
    const att = await upload(WT_SESSION_ID, "removeme.txt");
    const dir = pendingUploadsDir(worktreePathFor(), WT_SESSION_ID);
    expect(await readdir(dir)).toHaveLength(1);

    const del1 = await app.inject({ method: "DELETE", url: `/sessions/${WT_SESSION_ID}/attachments/${att.id}` });
    expect(del1.statusCode).toBe(200);
    expect(del1.json()).toEqual({ ok: true });
    expect(existsSync(att.path)).toBe(false);
    expect(await readdir(dir)).toHaveLength(0);

    // Second delete of the same id → 404, not a 500 (already gone, tolerated).
    const del2 = await app.inject({ method: "DELETE", url: `/sessions/${WT_SESSION_ID}/attachments/${att.id}` });
    expect(del2.statusCode).toBe(404);
  });

  it("3.T3b — DELETE racing the hook consume: hook deletes first, DELETE route still 404s cleanly (no 500)", async () => {
    const { createClaudePlugin } = await import("../agent-plugins/claude.js");
    const plugin = createClaudePlugin();
    const wtPath = worktreePathFor();
    await plugin.setupWorkspaceHooks!(wtPath);
    const att = await upload(WT_SESSION_ID, "raced.txt");

    // Hook consumes (deletes) the pending-uploads reference first.
    const scriptPath = join(wtPath, ".claude", "vibe-uploads.sh");
    await execFileAsync("bash", [scriptPath], {
      cwd: wtPath,
      env: { ...process.env, VST_SPAWN_TOKEN: WT_SESSION_ID, CLAUDE_PROJECT_DIR: wtPath },
    });

    // The registry entry is still present (hook only touches the filesystem
    // reference, not the daemon's in-memory registry) — the route still finds
    // and removes the staged file; the (already-gone) ref unlink is tolerated.
    const del = await app.inject({ method: "DELETE", url: `/sessions/${WT_SESSION_ID}/attachments/${att.id}` });
    expect(del.statusCode).toBe(200);
    expect(existsSync(att.path)).toBe(false);
  });

  it("3.T6 — upload to a terminal session with NO hook installed degrades gracefully (stages, no crash)", async () => {
    // setupWorkspaceHooks is deliberately never called here — simulates an
    // already-running session that hasn't respawned/toggled since the hook
    // shipped (Rollout gap, plan Research §3).
    const att = await upload(DIRECT_SESSION_ID, "orphan.txt");
    expect(existsSync(att.path)).toBe(true);
    const dir = pendingUploadsDir(directPathFor(), DIRECT_SESSION_ID);
    const entries = await readdir(dir);
    expect(entries).toHaveLength(1); // reference staged even though no hook will ever read it
  });
});
