/**
 * `resolveBaseSha()` — recomputes a worktree's current fork point against
 * `baseBranch` live (`git merge-base HEAD <baseBranch>`) instead of trusting
 * a `baseSha` value cached at worktree-creation time. See git.ts's doc
 * comment for why a cached value goes stale: a long-running branch that gets
 * synced/rebased onto an advancing base branch moves its true fork point
 * forward, but a cached `baseSha` doesn't follow — every commit the base
 * branch picked up since caching then misreads as "unique to this branch"
 * wherever the stale value is used.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveBaseSha } from "../services/git.js";
import { createGitFixture, removeGitFixture, type GitFixture } from "./gitFixture.js";

let fixture: GitFixture;
let repoDir: string;
let git: GitFixture["git"];

describe("resolveBaseSha", () => {
  beforeEach(async () => {
    fixture = await createGitFixture("vst-git-resolve-base-test");
    repoDir = fixture.dir;
    git = fixture.git;
  });

  afterEach(async () => {
    await removeGitFixture(fixture);
  });

  it("returns the live merge-base with baseBranch, not a stale cached value", async () => {
    // Original fork point.
    await writeFile(join(repoDir, "a.txt"), "a\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "commit 1"]);
    const staleBaseSha = git(["rev-parse", "HEAD"]).trim();

    // Branch off, add the branch's own commit.
    git(["checkout", "-q", "-b", "feature"]);
    await writeFile(join(repoDir, "b.txt"), "b\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "own commit"]);

    // main advances after the branch was cut, and the branch syncs with it
    // (merges main forward) — simulating a long-running branch workflow.
    git(["checkout", "-q", "main"]);
    await writeFile(join(repoDir, "c.txt"), "c\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "main advances"]);
    const newMainTip = git(["rev-parse", "HEAD"]).trim();

    git(["checkout", "-q", "feature"]);
    git(["merge", "-q", "-m", "sync with main", "main"]);

    // The stale cached baseSha still resolves, but it's no longer the true
    // fork point — merge-base with current main has moved to newMainTip.
    const resolved = await resolveBaseSha(repoDir, "main", staleBaseSha);
    expect(resolved).toBe(newMainTip);
    expect(resolved).not.toBe(staleBaseSha);
  });

  it("falls back to the stored baseSha when baseBranch doesn't resolve", async () => {
    await writeFile(join(repoDir, "a.txt"), "a\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "commit 1"]);
    const baseSha = git(["rev-parse", "HEAD"]).trim();

    const resolved = await resolveBaseSha(repoDir, "does-not-exist-branch", baseSha);
    expect(resolved).toBe(baseSha);
  });

  it("returns null when neither baseBranch nor the fallback resolves", async () => {
    await writeFile(join(repoDir, "a.txt"), "a\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "commit 1"]);

    // A well-formed but nonexistent SHA (not the all-zero null oid, which
    // `git rev-parse --verify` treats as a special case and resolves without
    // error rather than failing like a genuinely absent object would).
    const resolved = await resolveBaseSha(repoDir, "does-not-exist-branch", "f".repeat(40));
    expect(resolved).toBeNull();
  });

  it("returns null when baseBranch is absent and no fallback is given", async () => {
    const resolved = await resolveBaseSha(repoDir, null, null);
    expect(resolved).toBeNull();
  });

  // vcs-stale-base-branch: the local `<baseBranch>` ref is only ever updated
  // once, at worktree-creation time — it silently drifts stale for as long
  // as the daemon runs. `origin/<baseBranch>` (kept fresh by a caller that
  // fetches it, e.g. `GET /worktrees/:id/commits`) should be preferred when
  // it resolves, so these tests use a real second tmp repo as a fake
  // "origin" whose `main` can be advanced independently of the "clone"'s
  // local `main` — a mocked-only test couldn't actually distinguish
  // stale-local from fresh-origin behavior.
  describe("origin/<baseBranch> preference (vcs-stale-base-branch)", () => {
    let originFixture: GitFixture;

    beforeEach(async () => {
      originFixture = await createGitFixture("vst-git-resolve-base-origin-test");
      // Seed the origin with a first commit, then clone it into `repoDir`
      // (the fixture's repo, freshly `git init`ed with no history yet) so
      // `repoDir` has a real `origin` remote and a local `main` that starts
      // out equal to the origin's `main`.
      await writeFile(join(originFixture.dir, "seed.txt"), "seed\n");
      originFixture.git(["add", "-A"]);
      originFixture.git(["commit", "-q", "-m", "origin seed commit"]);

      git(["remote", "add", "origin", originFixture.dir]);
      git(["fetch", "-q", "origin"]);
      git(["reset", "-q", "--hard", "origin/main"]);
    });

    afterEach(async () => {
      await removeGitFixture(originFixture);
    });

    it("prefers the freshly-fetched origin/<baseBranch> over a stale local <baseBranch>", async () => {
      // Branch off "repoDir" for the worktree's own work.
      git(["checkout", "-q", "-b", "feature"]);
      const seedSha = git(["rev-parse", "main"]).trim();
      await writeFile(join(repoDir, "feature.txt"), "feature work\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "feature commit"]);

      // The real GitHub main advances (in the fake "origin" repo) — but
      // `repoDir`'s local `main` branch is never told about it, simulating
      // the daemon's stale local ref (which is only ever updated once, at
      // worktree-creation time).
      await writeFile(join(originFixture.dir, "advance.txt"), "advance\n");
      originFixture.git(["add", "-A"]);
      originFixture.git(["commit", "-q", "-m", "origin advances"]);
      const newOriginTip = originFixture.git(["rev-parse", "HEAD"]).trim();

      // Refresh only the remote-tracking ref, exactly like `fetchOrigin`
      // does — the local `main` branch itself is untouched (and stays at the
      // OLD seed commit, i.e. is now stale).
      git(["fetch", "-q", "origin", "main"]);
      const staleLocalMain = git(["rev-parse", "main"]).trim();
      const freshOriginMain = git(["rev-parse", "origin/main"]).trim();
      expect(staleLocalMain).toBe(seedSha);
      expect(freshOriginMain).toBe(newOriginTip);

      // The worktree branch syncs with the real (fresh) origin main — a
      // normal long-running-branch workflow — so its own history now
      // contains `newOriginTip`, but the stale local `main` branch pointer
      // never moves past the seed commit.
      git(["merge", "-q", "-m", "sync with origin/main", "origin/main"]);

      // merge-base(HEAD, local main=seed) is still the seed commit — local
      // main never advanced, so it can't "see" newOriginTip even though HEAD
      // now contains it.
      const staleMergeBase = git(["merge-base", "HEAD", "main"]).trim();
      expect(staleMergeBase).toBe(seedSha);

      const resolved = await resolveBaseSha(repoDir, "main", null);

      // resolveBaseSha must use origin/main (which correctly reflects that
      // HEAD has synced past it), not the stale local main.
      expect(resolved).toBe(newOriginTip);
      expect(resolved).not.toBe(staleMergeBase);
    });

    it("prefers the local <baseBranch> over a stale origin/<baseBranch> when local is more advanced", async () => {
      // The inverse of the "prefers fresh origin" case above: local `main`
      // moved ahead of the fetched `origin/main` (e.g. someone committed
      // directly to the local branch in the primary clone, or this daemon
      // session simply hasn't fetched since local was last pulled). Preferring
      // origin unconditionally here would make an already-merged-locally
      // commit misread as "unique to this branch" — the regression this test
      // guards against.
      git(["checkout", "-q", "-b", "feature"]);
      const seedSha = git(["rev-parse", "main"]).trim();
      await writeFile(join(repoDir, "feature.txt"), "feature work\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "feature commit"]);

      // Local main advances (simulating a direct local commit / manual pull)
      // — origin/main is never told about it, so origin/main stays stale at
      // the seed commit.
      git(["checkout", "-q", "main"]);
      await writeFile(join(repoDir, "advance.txt"), "advance\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "local main advances"]);
      const newLocalMainTip = git(["rev-parse", "main"]).trim();

      const staleOriginMain = git(["rev-parse", "origin/main"]).trim();
      expect(staleOriginMain).toBe(seedSha);

      // The worktree branch syncs with the advanced local main.
      git(["checkout", "-q", "feature"]);
      git(["merge", "-q", "-m", "sync with local main", "main"]);

      const resolved = await resolveBaseSha(repoDir, "main", null);

      // resolveBaseSha must prefer the more-advanced local main, not the
      // stale origin/main.
      expect(resolved).toBe(newLocalMainTip);
      expect(resolved).not.toBe(staleOriginMain);
    });

    it("falls back to the local <baseBranch> when origin/<baseBranch> doesn't resolve (no remote)", async () => {
      // A repo with no remote at all — origin/main can never resolve.
      const noRemoteFixture = await createGitFixture("vst-git-resolve-base-noremote-test");
      try {
        await writeFile(join(noRemoteFixture.dir, "a.txt"), "a\n");
        noRemoteFixture.git(["add", "-A"]);
        noRemoteFixture.git(["commit", "-q", "-m", "commit 1"]);
        const localMainTip = noRemoteFixture.git(["rev-parse", "main"]).trim();

        noRemoteFixture.git(["checkout", "-q", "-b", "feature"]);
        await writeFile(join(noRemoteFixture.dir, "b.txt"), "b\n");
        noRemoteFixture.git(["add", "-A"]);
        noRemoteFixture.git(["commit", "-q", "-m", "feature commit"]);

        const resolved = await resolveBaseSha(noRemoteFixture.dir, "main", null);
        expect(resolved).toBe(localMainTip);
      } finally {
        await removeGitFixture(noRemoteFixture);
      }
    });
  });
});
