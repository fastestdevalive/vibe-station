import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, chmod, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { FastifyInstance } from "fastify";

// Point homedir() at a temp dir so the `~` expansion tests are hermetic rather
// than depending on the real runner's home directory. On POSIX `os.homedir()`
// reads $HOME on every call, so overriding the env var is enough.
//
// Deliberately NOT `vi.mock("node:os", …)`: this suite calls `buildServer()`,
// which pulls in the entire route graph (including agent-plugins/registry.js).
// Re-evaluating that graph under a mocked builtin leaves `SUPPORTED_CLIS`
// undefined for other suites sharing the same vitest worker, which made
// projects.test.ts and sessions.test.ts fail to collect with a zod
// "Cannot convert undefined or null to object" at modes.ts:23.
// `git commit` needs an author identity. Because the tests above relocate
// $HOME, git can no longer read the runner's global gitconfig — so supply the
// identity inline rather than depending on the machine's git setup at all.
const GIT_IDENTITY = '-c user.name=vst-test -c user.email=vst-test@example.com';

let origHome: string | undefined;

function useTempHome(dir: string): void {
  origHome = process.env.HOME;
  process.env.HOME = dir;
}

function restoreHome(): void {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
}

describe("GET /fs/check", () => {
  let app: FastifyInstance;
  let tempDir: string;

  beforeEach(async () => {
    const { buildServer } = await import("../server.js");
    tempDir = await mkdtemp(join(tmpdir(), "vst-fscheck-test-"));
    useTempHome(tempDir);
    app = await buildServer();
  });

  afterEach(async () => {
    restoreHome();
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("400s when path is missing", async () => {
    const res = await app.inject({ method: "GET", url: "/fs/check" });
    expect(res.statusCode).toBe(400);
  });

  it("400s when path exceeds 4096 chars", async () => {
    const longPath = "/" + "a".repeat(4097);
    const res = await app.inject({
      method: "GET",
      url: `/fs/check?path=${encodeURIComponent(longPath)}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s on a null byte in the path", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/fs/check?path=${encodeURIComponent("/tmp/foo\0bar")}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s on a relative path", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/fs/check?path=${encodeURIComponent("relative/dir")}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("expands a bare ~ to the (mocked) home dir", async () => {
    const res = await app.inject({ method: "GET", url: "/fs/check?path=~" });
    expect(res.statusCode).toBe(200);
    const direct = await app.inject({
      method: "GET",
      url: `/fs/check?path=${encodeURIComponent(tempDir)}`,
    });
    expect(res.json()).toEqual(direct.json());
    expect(res.json<{ exists: boolean }>().exists).toBe(true);
  });

  it("expands ~/subpath to <home>/subpath", async () => {
    const sub = join(tempDir, "sub-dir");
    await mkdir(sub);
    const res = await app.inject({ method: "GET", url: "/fs/check?path=~/sub-dir" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ exists: boolean; isDirectory: boolean }>();
    expect(body).toEqual({ exists: true, isDirectory: true, isGit: false, hasCommits: null });
  });

  it("returns 200 { exists: false } for a nonexistent path — never a 404/500", async () => {
    const missing = join(tempDir, "does-not-exist");
    const res = await app.inject({
      method: "GET",
      url: `/fs/check?path=${encodeURIComponent(missing)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ exists: false, isDirectory: false, isGit: false, hasCommits: null });
  });

  it("returns { exists: true, isDirectory: false } for an existing file (not lossy-false)", async () => {
    const filePath = join(tempDir, "a-file.txt");
    await writeFile(filePath, "hello");
    const res = await app.inject({
      method: "GET",
      url: `/fs/check?path=${encodeURIComponent(filePath)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ exists: true, isDirectory: false, isGit: false, hasCommits: null });
  });

  it("plain (non-git) directory → isGit: false", async () => {
    const plainDir = join(tempDir, "plain");
    await mkdir(plainDir);
    const res = await app.inject({
      method: "GET",
      url: `/fs/check?path=${encodeURIComponent(plainDir)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ exists: true, isDirectory: true, isGit: false, hasCommits: null });
  });

  it("git-inited directory with no commits → isGit: true, hasCommits: false", async () => {
    const repoDir = join(tempDir, "empty-repo");
    execSync(`mkdir -p "${repoDir}" && git init "${repoDir}"`, { stdio: "ignore" });
    const res = await app.inject({
      method: "GET",
      url: `/fs/check?path=${encodeURIComponent(repoDir)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ isGit: boolean; hasCommits: boolean | null }>();
    expect(body.isGit).toBe(true);
    expect(body.hasCommits).toBe(false);
  });

  it("git-inited directory with a commit → isGit: true, hasCommits: true", async () => {
    const repoDir = join(tempDir, "repo-with-commit");
    execSync(
      `mkdir -p "${repoDir}" && git init "${repoDir}" && git -C "${repoDir}" ${GIT_IDENTITY} commit --allow-empty -m init`,
      { stdio: "ignore" },
    );
    const res = await app.inject({
      method: "GET",
      url: `/fs/check?path=${encodeURIComponent(repoDir)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ isGit: boolean; hasCommits: boolean | null }>();
    expect(body.isGit).toBe(true);
    expect(body.hasCommits).toBe(true);
  });

  it("a subdirectory of a repo → isGit: true (intentional — matches routes/projects.ts's isGitRepo)", async () => {
    const repoDir = join(tempDir, "parent-repo");
    const subDir = join(repoDir, "nested", "deeper");
    execSync(
      `mkdir -p "${subDir}" && git init "${repoDir}" && git -C "${repoDir}" ${GIT_IDENTITY} commit --allow-empty -m init`,
      { stdio: "ignore" },
    );
    const res = await app.inject({
      method: "GET",
      url: `/fs/check?path=${encodeURIComponent(subDir)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ isGit: boolean }>();
    expect(body.isGit).toBe(true);
  });

  // Skipped when running as root — root ignores permission bits, so a chmod
  // 000 ancestor wouldn't actually block traversal (the test would silently
  // pass for the wrong reason in a root-in-container setup).
  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "an unreadable ancestor directory never 500s — falls back to exists: false",
    async () => {
      const blockedParent = join(tempDir, "blocked");
      const child = join(blockedParent, "child");
      await mkdir(blockedParent);
      await mkdir(child);
      await chmod(blockedParent, 0o000);
      try {
        const res = await app.inject({
          method: "GET",
          url: `/fs/check?path=${encodeURIComponent(child)}`,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json<{ exists: boolean }>().exists).toBe(false);
      } finally {
        // Restore permissions so afterEach's rm() can clean up.
        await chmod(blockedParent, 0o755);
      }
    },
  );
});

describe("GET /fs/complete", () => {
  let app: FastifyInstance;
  let tempDir: string;

  beforeEach(async () => {
    const { buildServer } = await import("../server.js");
    tempDir = await mkdtemp(join(tmpdir(), "vst-fscomplete-test-"));
    useTempHome(tempDir);
    app = await buildServer();
  });

  afterEach(async () => {
    restoreHome();
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("400s on a null byte in the path", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/fs/complete?path=${encodeURIComponent("/tmp/foo\0bar")}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("never 500s on an unreadable directory — returns an empty list", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/fs/complete?path=${encodeURIComponent(join(tempDir, "nope") + "/")}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ base: join(tempDir, "nope") + "/", entries: [], truncated: false });
  });

  it("sorts alphabetically-first entries into the cap instead of an arbitrary readdir-order slice", async () => {
    // 60 dirs created in descending order so a capped-before-sort implementation
    // would keep an arbitrary readdir-order 50 instead of the alphabetically
    // first 50 ("dir-00".."dir-49") — this pins the D3 sort-before-cap fix.
    for (let i = 59; i >= 0; i--) {
      await mkdir(join(tempDir, `dir-${String(i).padStart(2, "0")}`));
    }
    const res = await app.inject({
      method: "GET",
      url: `/fs/complete?path=${encodeURIComponent(tempDir + "/")}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ entries: { name: string }[]; truncated: boolean }>();
    expect(body.truncated).toBe(true);
    expect(body.entries).toHaveLength(50);
    expect(body.entries[0]?.name).toBe("dir-00");
    expect(body.entries[49]?.name).toBe("dir-49");
  });

  it("truncated is false when entries fit under the cap", async () => {
    await mkdir(join(tempDir, "only-one"));
    const res = await app.inject({
      method: "GET",
      url: `/fs/complete?path=${encodeURIComponent(tempDir + "/")}`,
    });
    const body = res.json<{ truncated: boolean }>();
    expect(body.truncated).toBe(false);
  });

  it("plain files never count toward the cap or toward truncated", async () => {
    // A file-heavy directory used to report truncated:true while omitting no
    // directory at all, so the Browse dialog showed a "showing the first 50"
    // warning above a two-row list. Only directory-ish dirents may count.
    for (let i = 0; i < 60; i++) {
      await writeFile(join(tempDir, `file-${String(i).padStart(2, "0")}.txt`), "x");
    }
    await mkdir(join(tempDir, "a-dir"));
    await mkdir(join(tempDir, "b-dir"));

    const res = await app.inject({
      method: "GET",
      url: `/fs/complete?path=${encodeURIComponent(tempDir + "/")}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ entries: { name: string }[]; truncated: boolean }>();
    expect(body.entries.map((e) => e.name)).toEqual(["a-dir", "b-dir"]);
    expect(body.truncated).toBe(false);
  });
});
