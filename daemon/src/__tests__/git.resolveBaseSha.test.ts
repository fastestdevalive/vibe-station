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
});
