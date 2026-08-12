/**
 * `listCommits()` / `attachFullBodies()` — the VCS tool tab's commit-graph data source.
 *
 * `listCommits()` parses `git log --numstat` output using a header line built
 * from `%s` (subject only, never the body) — this test suite is deliberately
 * adversarial about that boundary: Requirement 3a proves a commit subject
 * containing the parser's own RS/US delimiter bytes can't corrupt OTHER
 * commits in the list (git.ts's `FULL_SHA_RE` guard drops any resulting
 * fragment whose "sha" field isn't actually a valid sha) — it does not claim
 * to fully recover the adversarial commit's own data, only to contain the
 * damage to that one commit. Requirement 3b proves a hostile *body* round-trips
 * through the separate `attachFullBodies()` call untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCommits } from "../services/git.js";
import { createGitFixture, removeGitFixture, type GitFixture } from "./gitFixture.js";

let fixture: GitFixture;
let repoDir: string;
let git: GitFixture["git"];

describe("listCommits", () => {
  beforeEach(async () => {
    fixture = await createGitFixture("vst-git-commits-test");
    repoDir = fixture.dir;
    git = fixture.git;
  });

  afterEach(async () => {
    await removeGitFixture(fixture);
  });

  it("Requirement 1 — empty repo (no commits) returns [] without throwing", async () => {
    await expect(listCommits(repoDir)).resolves.toEqual([]);
  });

  it("Requirement 2 — a binary file alongside a text file in the same commit: binary excluded from the diffstat sum, text file's lines still counted", async () => {
    // Both files in ONE commit — proves the numstat loop's `continue` past a
    // binary line doesn't also drop the text file's line that follows it
    // (a `continue` → `break`/early-return regression would fail this).
    await writeFile(join(repoDir, "text.txt"), "one\ntwo\nthree\n");
    await writeFile(join(repoDir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "add text file and binary blob together"]);

    const commits = await listCommits(repoDir);
    expect(commits).toHaveLength(1);
    const commit = commits[0]!;
    expect(commit.hasBinaryChanges).toBe(true);
    expect(commit.insertions).toBe(3); // only text.txt's 3 lines
    expect(commit.deletions).toBe(0);
  });

  it("Requirement 3a — a subject containing the parser's own RS/US delimiter bytes doesn't corrupt the commit list (defensive sha-shape guard)", async () => {
    await writeFile(join(repoDir, "a.txt"), "a\n");
    git(["add", "-A"]);
    // %H is always 40 hex chars and can never legitimately contain RS(0x1e)/
    // US(0x1f) — a commit subject that does is the exact adversarial input
    // git.ts's `FULL_SHA_RE` guard exists for. Constructed via `-F` (a temp
    // file OUTSIDE the repo dir, so it never gets picked up by a later
    // `git add -A`) since these are raw control bytes, not shell-escapable text.
    const msgFile = join(tmpdir(), `vst-adversarial-msg-${process.pid}-${Date.now()}`);
    await writeFile(msgFile, `evil\x1esubject\x1fwith-delimiters`);
    git(["commit", "-q", "-F", msgFile]);

    await writeFile(join(repoDir, "b.txt"), "b\nb2\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "normal follow-up commit"]);

    const commits = await listCommits(repoDir);
    // The real, well-formed follow-up commit parses correctly and isn't
    // corrupted by the preceding commit's fractured block — this is the
    // main thing the guard protects: OTHER commits' data staying intact.
    const followUp = commits.find((c) => c.subject === "normal follow-up commit");
    expect(followUp).toBeDefined();
    expect(followUp!.insertions).toBe(2);
    // Every surviving entry has a well-formed 40-hex sha — the fragment
    // whose "sha" field was actually leftover subject text ("subject",
    // not hex) is dropped by the guard rather than rendered as a phantom
    // row with a garbage id.
    for (const c of commits) {
      expect(c.sha).toMatch(/^[0-9a-f]{40}$/);
    }
    // What the guard does NOT claim to fix: the adversarial commit's OWN
    // subject/stats can still end up truncated (data attached to the sha
    // that appears before the embedded delimiter survives; data attached
    // to the fragment after it — like this commit's own numstat — does
    // not). Documented here so a future reader doesn't mistake this for
    // full recovery of the adversarial commit itself.
    const adversarial = commits.find((c) => c.subject === "evil");
    expect(adversarial).toBeDefined();
    expect(adversarial!.insertions).toBe(0);
  });

  it("Requirement 3b — a multi-paragraph body round-trips through attachFullBodies with newlines intact", async () => {
    await writeFile(join(repoDir, "a.txt"), "a\n");
    git(["add", "-A"]);
    const body = "First paragraph of the body.\n\nSecond paragraph, with more detail\nspanning two lines.";
    git(["commit", "-q", "-m", "adversarial body commit", "-m", body]);

    const commits = await listCommits(repoDir);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.subject).toBe("adversarial body commit");
    expect(commits[0]!.body).toBe(`adversarial body commit\n\n${body}`);
  });

  it("Requirement 4 — a commit with no body has body === subject, and every metadata field is populated correctly", async () => {
    await writeFile(join(repoDir, "a.txt"), "a\n");
    git(["add", "-A"]);
    git(["config", "user.name", "Ada Lovelace"]);
    git(["config", "user.email", "ada@example.com"]);
    git(["commit", "-q", "-m", "single line commit"]);

    const commits = await listCommits(repoDir);
    expect(commits).toHaveLength(1);
    const c = commits[0]!;
    expect(c.subject).toBe("single line commit");
    expect(c.body).toBe("single line commit");
    // Guards the positional destructure in git.ts (`[sha, shortSha,
    // authorName, authorEmail, date, subject] = header.split(US)`) against a
    // silent field-order regression.
    expect(c.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(c.shortSha).toBe(c.sha.slice(0, 7));
    expect(c.authorName).toBe("Ada Lovelace");
    expect(c.authorEmail).toBe("ada@example.com");
    expect(c.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("merge commits get a real first-parent diffstat, not 0/0", async () => {
    await writeFile(join(repoDir, "base.txt"), "base\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "base commit"]);

    git(["checkout", "-q", "-b", "feature"]);
    await writeFile(join(repoDir, "feature.txt"), "line one\nline two\nline three\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "feature commit"]);

    git(["checkout", "-q", "main"]);
    git(["merge", "-q", "--no-ff", "-m", "merge feature into main", "feature"]);

    const commits = await listCommits(repoDir);
    const mergeCommit = commits.find((c) => c.subject === "merge feature into main");
    expect(mergeCommit).toBeDefined();
    expect(mergeCommit!.insertions).toBe(3);
    expect(mergeCommit!.deletions).toBe(0);
  });
});
