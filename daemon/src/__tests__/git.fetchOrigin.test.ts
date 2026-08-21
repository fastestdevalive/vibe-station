/**
 * `fetchOrigin()` — best-effort `git fetch origin <ref>`, used to refresh the
 * `origin/<baseBranch>` remote-tracking ref on demand (see
 * `GET /worktrees/:id/commits` and `resolveBaseSha`'s doc comment for why).
 * Was previously unbounded (`execFile` with no `timeout`) — a hung/slow
 * network fetch could hang whatever request triggered it. These tests cover
 * both the existing best-effort (swallow-errors) contract and the new
 * bounded timeout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdtemp, chmod, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchOrigin, revParse, _clearFetchOriginStateForTest } from "../services/git.js";
import { createGitFixture, removeGitFixture, type GitFixture } from "./gitFixture.js";

let fixture: GitFixture;
let repoDir: string;
let git: GitFixture["git"];

/**
 * Shadows `git` on PATH with a script that just appends one line to
 * `counterFile` per invocation and exits 0 — reused pattern (see the
 * bounded-timeout test below) for proving real subprocess-count behavior
 * rather than mocking at the JS level. Returns the fake bin dir and a
 * `count()` helper; caller is responsible for restoring `PATH` and removing
 * the fake bin dir.
 */
async function installCountingFakeGit(counterFile: string): Promise<{ fakeBinDir: string; restore: () => Promise<void> }> {
  const fakeBinDir = await mkdtemp(join(tmpdir(), "vst-git-fetchorigin-fakebin-"));
  const fakeGitPath = join(fakeBinDir, "git");
  await writeFile(fakeGitPath, `#!/bin/sh\necho invoked >> "${counterFile}"\nexit 0\n`);
  await chmod(fakeGitPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${originalPath}`;
  return {
    fakeBinDir,
    restore: async () => {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(fakeBinDir, { recursive: true, force: true });
    },
  };
}

async function countInvocations(counterFile: string): Promise<number> {
  try {
    const text = await readFile(counterFile, "utf8");
    return text.split("\n").filter((l) => l.trim() !== "").length;
  } catch {
    return 0;
  }
}

/**
 * Like `installCountingFakeGit`, but the fake script exits non-zero (after
 * still recording an invocation), to prove `fetchOrigin`'s failure path:
 * the in-flight map entry must still be cleared (so a later call for the
 * same key isn't stuck forever), and — per the cooldown-on-success-only fix
 * — a failed call must NOT enter the cooldown, so the very next call for the
 * same key performs a real fetch again rather than a silent no-op.
 */
async function installFailingFakeGit(counterFile: string): Promise<{ fakeBinDir: string; restore: () => Promise<void> }> {
  const fakeBinDir = await mkdtemp(join(tmpdir(), "vst-git-fetchorigin-failbin-"));
  const fakeGitPath = join(fakeBinDir, "git");
  await writeFile(fakeGitPath, `#!/bin/sh\necho invoked >> "${counterFile}"\nexit 1\n`);
  await chmod(fakeGitPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${originalPath}`;
  return {
    fakeBinDir,
    restore: async () => {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(fakeBinDir, { recursive: true, force: true });
    },
  };
}

describe("fetchOrigin", () => {
  beforeEach(async () => {
    fixture = await createGitFixture("vst-git-fetchorigin-test");
    repoDir = fixture.dir;
    git = fixture.git;
    _clearFetchOriginStateForTest();
  });

  afterEach(async () => {
    await removeGitFixture(fixture);
    _clearFetchOriginStateForTest();
    vi.restoreAllMocks();
  });

  it("updates the origin/<ref> remote-tracking ref on success", async () => {
    const originFixture = await createGitFixture("vst-git-fetchorigin-origin-test");
    try {
      await writeFile(join(originFixture.dir, "seed.txt"), "seed\n");
      originFixture.git(["add", "-A"]);
      originFixture.git(["commit", "-q", "-m", "origin seed"]);
      const originTip = originFixture.git(["rev-parse", "HEAD"]).trim();

      git(["remote", "add", "origin", originFixture.dir]);

      await fetchOrigin(repoDir, "main");

      const trackingRef = await revParse(repoDir, "origin/main");
      expect(trackingRef).toBe(originTip);
    } finally {
      await removeGitFixture(originFixture);
    }
  });

  it("swallows errors and resolves without throwing when there is no remote", async () => {
    await expect(fetchOrigin(repoDir, "main")).resolves.toBeUndefined();
  });

  it(
    "does not hang past the bounded timeout when the underlying git process never returns",
    async () => {
      // Shadow `git` on PATH with a script that hangs, to prove `fetchOrigin`
      // is actually bounded (not just "usually fast") — without this, a
      // regression back to an unbounded `execFile` wouldn't be caught by any
      // of the other (fast, well-behaved) tests here. Own `mkdtemp`'d dir
      // (not a sibling of `repoDir` cleaned up implicitly) so it's guaranteed
      // removed in `finally` regardless of `removeGitFixture`.
      const fakeBinDir = await mkdtemp(join(tmpdir(), "vst-git-fetchorigin-fakebin-"));
      try {
        const fakeGitPath = join(fakeBinDir, "git");
        await writeFile(fakeGitPath, "#!/bin/sh\nsleep 2\n");
        await chmod(fakeGitPath, 0o755);

        const originalPath = process.env.PATH;
        process.env.PATH = `${fakeBinDir}:${originalPath}`;
        try {
          const start = Date.now();
          // A short `timeoutMs` (well under the 2s the fake `git` sleeps for)
          // proves the bound is enforced without waiting out the real
          // production 8s default on every test run.
          await fetchOrigin(repoDir, "main", 300);
          const elapsedMs = Date.now() - start;
          expect(elapsedMs).toBeLessThan(2_000);
        } finally {
          if (originalPath === undefined) delete process.env.PATH;
          else process.env.PATH = originalPath;
        }
      } finally {
        await rm(fakeBinDir, { recursive: true, force: true });
      }
    },
  );

  describe("in-flight dedupe + cooldown", () => {
    it("dedupes concurrent calls for the same (repoPath, ref) into exactly one subprocess", async () => {
      const counterFile = join(repoDir, "counter.txt");
      const { restore } = await installCountingFakeGit(counterFile);
      try {
        await Promise.all([fetchOrigin(repoDir, "main"), fetchOrigin(repoDir, "main")]);
        expect(await countInvocations(counterFile)).toBe(1);
      } finally {
        await restore();
      }
    });

    it("does NOT dedupe a different ref for the same repoPath", async () => {
      const counterFile = join(repoDir, "counter.txt");
      const { restore } = await installCountingFakeGit(counterFile);
      try {
        await Promise.all([fetchOrigin(repoDir, "main"), fetchOrigin(repoDir, "other")]);
        expect(await countInvocations(counterFile)).toBe(2);
      } finally {
        await restore();
      }
    });

    it("does NOT dedupe the same ref for a different repoPath", async () => {
      const otherFixture = await createGitFixture("vst-git-fetchorigin-other-repo");
      try {
        const counterFile = join(repoDir, "counter.txt");
        const { restore } = await installCountingFakeGit(counterFile);
        try {
          await Promise.all([fetchOrigin(repoDir, "main"), fetchOrigin(otherFixture.dir, "main")]);
          expect(await countInvocations(counterFile)).toBe(2);
        } finally {
          await restore();
        }
      } finally {
        await removeGitFixture(otherFixture);
      }
    });

    it("a same-key call within the cooldown window after completion resolves without a new subprocess", async () => {
      const counterFile = join(repoDir, "counter.txt");
      const { restore } = await installCountingFakeGit(counterFile);
      try {
        await fetchOrigin(repoDir, "main");
        expect(await countInvocations(counterFile)).toBe(1);

        // Immediately re-call for the same key — still well inside the 5s
        // cooldown, so this must resolve with no additional subprocess.
        await fetchOrigin(repoDir, "main");
        expect(await countInvocations(counterFile)).toBe(1);
      } finally {
        await restore();
      }
    });

    it("a same-key call after the cooldown window elapses performs a real fetch again", async () => {
      const counterFile = join(repoDir, "counter.txt");
      const { restore } = await installCountingFakeGit(counterFile);
      try {
        const realNow = Date.now.bind(Date);
        let offsetMs = 0;
        const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);

        try {
          await fetchOrigin(repoDir, "main");
          expect(await countInvocations(counterFile)).toBe(1);

          // Advance the clock past the 5s cooldown window (mirrors
          // `github.ts`'s `CACHE_TTL_MS = 5_000`) — not a permanent cache, so
          // a call after the window must fetch for real again.
          offsetMs = 5_001;
          await fetchOrigin(repoDir, "main");
          expect(await countInvocations(counterFile)).toBe(2);
        } finally {
          nowSpy.mockRestore();
        }
      } finally {
        await restore();
      }
    });

    it("a failing fetch still clears the in-flight entry and does NOT enter the cooldown", async () => {
      const counterFile = join(repoDir, "counter.txt");
      const { restore } = await installFailingFakeGit(counterFile);
      try {
        // First call fails (fake git exits 1) but must still resolve
        // (best-effort contract) rather than reject.
        await expect(fetchOrigin(repoDir, "main")).resolves.toBeUndefined();
        expect(await countInvocations(counterFile)).toBe(1);

        // A second call for the same key, made immediately after (well
        // inside what would have been the 5s cooldown window had the first
        // call succeeded), must still perform a REAL fetch attempt — not be
        // silently skipped — because the previous attempt failed. This also
        // proves the in-flight map entry was cleared: if it weren't, this
        // call would hang awaiting an already-settled promise instead of
        // spawning a new subprocess.
        await expect(fetchOrigin(repoDir, "main")).resolves.toBeUndefined();
        expect(await countInvocations(counterFile)).toBe(2);
      } finally {
        await restore();
      }
    });

    it("_clearFetchOriginStateForTest restores real-fetch behavior after a primed cooldown", async () => {
      const counterFile = join(repoDir, "counter.txt");
      const { restore } = await installCountingFakeGit(counterFile);
      try {
        await fetchOrigin(repoDir, "main");
        expect(await countInvocations(counterFile)).toBe(1);

        // Still well inside the cooldown window — would normally resolve
        // with no new subprocess.
        await fetchOrigin(repoDir, "main");
        expect(await countInvocations(counterFile)).toBe(1);

        // Clearing the test-only state must make the NEXT call for the same
        // key perform a real fetch again, proving the reset actually
        // discards the primed cooldown rather than being a no-op.
        _clearFetchOriginStateForTest();
        await fetchOrigin(repoDir, "main");
        expect(await countInvocations(counterFile)).toBe(2);
      } finally {
        await restore();
      }
    });
  });
});
