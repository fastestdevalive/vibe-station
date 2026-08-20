/**
 * `listSubmodules()` — the VCS tool tab's "Submodules" section data source.
 * Uses real temp git repos (via `gitFixture.ts`) with an actual
 * `git submodule add`, not mocked `git` output — submodule status line
 * parsing (`git submodule status`'s leading char) and `.gitmodules` parsing
 * are exactly the kind of format-fragile code that's worth testing against
 * the real CLI.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { listSubmodules } from "../services/git.js";
import { createGitFixture, removeGitFixture, type GitFixture } from "./gitFixture.js";

let outer: GitFixture;
let sub: GitFixture;

describe("listSubmodules", () => {
  beforeEach(async () => {
    outer = await createGitFixture("vst-git-submodules-outer-test");
    sub = await createGitFixture("vst-git-submodules-sub-test");
  });

  afterEach(async () => {
    await removeGitFixture(outer);
    await removeGitFixture(sub);
  });

  it("Requirement 3a — a repo with no .gitmodules returns [] without throwing", async () => {
    await expect(listSubmodules(outer.dir)).resolves.toEqual([]);
  });

  it("Requirement 3a — an empty repo (not even a commit yet) returns [] without throwing", async () => {
    const { dir } = await createGitFixture("vst-git-submodules-empty-test");
    try {
      await expect(listSubmodules(dir)).resolves.toEqual([]);
    } finally {
      await removeGitFixture({ dir, git: () => "" });
    }
  });

  it("Requirement 3b — an initialized submodule: path, sha, shortSha, branch, subject, status all populated", async () => {
    // The submodule repo needs at least one commit to be addable.
    sub.git(["commit", "--allow-empty", "-q", "-m", "submodule initial commit"]);

    outer.git(["commit", "--allow-empty", "-q", "-m", "outer initial commit"]);
    outer.git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.dir, "vendor/widget"]);
    outer.git(["commit", "-q", "-m", "add vendor/widget submodule"]);

    const subSha = sub.git(["rev-parse", "HEAD"]).trim();

    const result = await listSubmodules(outer.dir);
    expect(result).toHaveLength(1);
    const entry = result[0]!;
    expect(entry.path).toBe("vendor/widget");
    expect(entry.sha).toBe(subSha);
    expect(entry.shortSha).toBe(subSha.slice(0, 7));
    expect(entry.subject).toBe("submodule initial commit");
    expect(entry.status).toBe("clean");
    // `branch` wasn't set in `.gitmodules` (plain `submodule add`, no
    // `-b <branch>`), so it's null, not an empty string.
    expect(entry.branch).toBeNull();
  });

  it("Requirement 3b — .gitmodules' branch entry is surfaced on the matching submodule", async () => {
    sub.git(["commit", "--allow-empty", "-q", "-m", "submodule initial commit"]);
    sub.git(["branch", "-m", "main", "feature-x"]);

    outer.git(["commit", "--allow-empty", "-q", "-m", "outer initial commit"]);
    outer.git([
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      "-b",
      "feature-x",
      sub.dir,
      "vendor/widget",
    ]);
    outer.git(["commit", "-q", "-m", "add vendor/widget submodule tracking feature-x"]);

    const result = await listSubmodules(outer.dir);
    expect(result).toHaveLength(1);
    expect(result[0]!.branch).toBe("feature-x");
  });

  it("Requirement 3c — an uninitialized submodule: sha present, subject null, status uninitialized", async () => {
    sub.git(["commit", "--allow-empty", "-q", "-m", "submodule initial commit"]);
    const subSha = sub.git(["rev-parse", "HEAD"]).trim();

    outer.git(["commit", "--allow-empty", "-q", "-m", "outer initial commit"]);
    outer.git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.dir, "vendor/widget"]);
    outer.git(["commit", "-q", "-m", "add vendor/widget submodule"]);

    // Simulate a fresh clone that never ran `git submodule update --init`:
    // deinit the submodule so its working tree/local repo is gone, but its
    // `.gitmodules`/index entry (and pinned sha) remain.
    outer.git(["submodule", "deinit", "-f", "vendor/widget"]);

    const result = await listSubmodules(outer.dir);
    expect(result).toHaveLength(1);
    const entry = result[0]!;
    expect(entry.path).toBe("vendor/widget");
    expect(entry.sha).toBe(subSha);
    expect(entry.subject).toBeNull();
    expect(entry.status).toBe("uninitialized");
  });

  it("Requirement 3d — a corrupted .gitmodules / git-invocation failure fails open to [] without throwing", async () => {
    sub.git(["commit", "--allow-empty", "-q", "-m", "submodule initial commit"]);
    outer.git(["commit", "--allow-empty", "-q", "-m", "outer initial commit"]);
    outer.git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.dir, "vendor/widget"]);
    outer.git(["commit", "-q", "-m", "add vendor/widget submodule"]);

    // Destroy `.git` itself (not `.gitmodules`, which is a plain tracked
    // file and survives) so `.gitmodules` parses fine — `branchByPath` is
    // non-empty — but the subsequent `git submodule status` invocation
    // throws (no `.git` to run it against).
    const { rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await rm(join(outer.dir, ".git"), { recursive: true, force: true });

    await expect(listSubmodules(outer.dir)).resolves.toEqual([]);
  });

  it("dirty working tree AT the pinned commit (status flag ' ') is reported 'modified', not 'clean'", async () => {
    // `git submodule status`'s `+` flag only means "checked-out SHA differs
    // from the superproject's pin" — a submodule sitting exactly at the pin
    // but with uncommitted local edits gets flag `" "` instead, and still
    // has to be surfaced as dirty rather than silently reported "clean".
    sub.git(["commit", "--allow-empty", "-q", "-m", "submodule initial commit"]);

    outer.git(["commit", "--allow-empty", "-q", "-m", "outer initial commit"]);
    outer.git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.dir, "vendor/widget"]);
    outer.git(["commit", "-q", "-m", "add vendor/widget submodule"]);

    // Edit a file inside the submodule's working tree without committing —
    // checked-out SHA still matches the pin (flag stays `" "`), but the
    // submodule now has real local changes.
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(outer.dir, "vendor/widget", "dirty.txt"), "uncommitted change\n");

    const result = await listSubmodules(outer.dir);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("modified");
  });

  it("out-of-date (checked-out SHA differs from the pin) takes precedence over a dirty working tree", async () => {
    sub.git(["commit", "--allow-empty", "-q", "-m", "c1"]);
    sub.git(["commit", "--allow-empty", "-q", "-m", "c2"]);
    const c1Sha = sub.git(["rev-parse", "HEAD~1"]).trim();

    outer.git(["commit", "--allow-empty", "-q", "-m", "outer initial commit"]);
    outer.git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.dir, "vendor/widget"]);
    outer.git(["commit", "-q", "-m", "add vendor/widget submodule pinned at c2"]);

    // Move the submodule's checked-out commit to c1 (already present locally
    // from the initial clone, no fetch needed) — differs from the
    // superproject's pin (c2), so the status flag becomes `+` — AND leave an
    // uncommitted change in its working tree.
    outer.git(["-C", "vendor/widget", "checkout", "-q", c1Sha]);
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(outer.dir, "vendor/widget", "dirty.txt"), "uncommitted change\n");

    const result = await listSubmodules(outer.dir);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("out-of-date");
  });

  it("Requirement 3f-adjacent — multiple submodules are all returned, each independently resolved", async () => {
    const sub2 = await createGitFixture("vst-git-submodules-sub2-test");
    try {
      sub.git(["commit", "--allow-empty", "-q", "-m", "sub1 commit"]);
      sub2.git(["commit", "--allow-empty", "-q", "-m", "sub2 commit"]);

      outer.git(["commit", "--allow-empty", "-q", "-m", "outer initial commit"]);
      outer.git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.dir, "vendor/one"]);
      outer.git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub2.dir, "vendor/two"]);
      outer.git(["commit", "-q", "-m", "add two submodules"]);

      const result = await listSubmodules(outer.dir);
      const paths = result.map((r) => r.path).sort();
      expect(paths).toEqual(["vendor/one", "vendor/two"]);
      expect(result.every((r) => r.status === "clean")).toBe(true);
    } finally {
      await removeGitFixture(sub2);
    }
  });
});
