/**
 * `fetchOrigin()` — best-effort `git fetch origin <ref>`, used to refresh the
 * `origin/<baseBranch>` remote-tracking ref on demand (see
 * `GET /worktrees/:id/commits` and `resolveBaseSha`'s doc comment for why).
 * Was previously unbounded (`execFile` with no `timeout`) — a hung/slow
 * network fetch could hang whatever request triggered it. These tests cover
 * both the existing best-effort (swallow-errors) contract and the new
 * bounded timeout.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchOrigin, revParse } from "../services/git.js";
import { createGitFixture, removeGitFixture, type GitFixture } from "./gitFixture.js";

let fixture: GitFixture;
let repoDir: string;
let git: GitFixture["git"];

describe("fetchOrigin", () => {
  beforeEach(async () => {
    fixture = await createGitFixture("vst-git-fetchorigin-test");
    repoDir = fixture.dir;
    git = fixture.git;
  });

  afterEach(async () => {
    await removeGitFixture(fixture);
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
          process.env.PATH = originalPath;
        }
      } finally {
        await rm(fakeBinDir, { recursive: true, force: true });
      }
    },
  );
});
