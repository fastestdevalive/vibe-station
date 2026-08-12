/**
 * Shared "real temp git repo" test fixture — `mkdtemp` + `git init` + a thin
 * `execFileSync` wrapper — used by any unit test that needs to run actual
 * `git` commands against a throwaway repo (as opposed to `worktrees.test.ts`'s
 * `app.inject`-based route fixture, which spins up the whole Fastify server).
 * Not itself a `.test.ts` file — vitest's `include` glob only picks up
 * `*.test.ts`, so this helper is never run as a suite of its own.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export interface GitFixture {
  dir: string;
  git(args: string[]): string;
}

/** Creates a fresh temp git repo (branch `main`, test author/email configured). */
export async function createGitFixture(prefix: string): Promise<GitFixture> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const git = (args: string[]): string =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);

  return { dir, git };
}

/** Removes a fixture's temp directory. Call from `afterEach`. */
export async function removeGitFixture(fixture: GitFixture): Promise<void> {
  await rm(fixture.dir, { recursive: true, force: true });
}
