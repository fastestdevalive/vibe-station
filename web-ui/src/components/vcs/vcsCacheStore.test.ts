import { describe, it, expect, beforeEach } from "vitest";
import type { CommitLogEntry } from "@/api/types";
import {
  MAX_SHAS,
  getShaDiff,
  getShaFiles,
  resetVcsCacheForTests,
  setShaDiff,
  setShaFiles,
  useVcsCacheStore,
  vcsKey,
} from "./vcsCacheStore";

const KEY = vcsKey("worktree", "wt1");
const FULL = (n: number) => n.toString(16).padStart(40, "0");

function commit(sha: string): CommitLogEntry {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    authorName: "A",
    authorEmail: "a@example.com",
    date: "2026-01-01T00:00:00Z",
    subject: `commit ${sha.slice(0, 4)}`,
    body: "",
    insertions: 1,
    deletions: 0,
    hasBinaryChanges: false,
    isOnBranch: true,
  };
}

describe("vcsCacheStore", () => {
  beforeEach(() => {
    resetVcsCacheForTests();
  });

  it("replace then fail keeps the rows and sets error", () => {
    const s = useVcsCacheStore.getState();
    s.replace(KEY, [commit(FULL(1))], 50);
    useVcsCacheStore.getState().fail(KEY, "network down");
    const e = useVcsCacheStore.getState().entries[KEY]!;
    expect(e.status).toBe("ready");
    expect(e.commits).toHaveLength(1);
    expect(e.error).toBe("network down");
    expect(e.fetchedAt).not.toBeNull();
  });

  it("a cold failure goes to status error", () => {
    useVcsCacheStore.getState().beginLoad(KEY, { cold: true, pageLimit: 50 });
    useVcsCacheStore.getState().fail(KEY, "boom");
    expect(useVcsCacheStore.getState().entries[KEY]!.status).toBe("error");
  });

  it("replace keeps the array identity when the SHAs are unchanged", () => {
    useVcsCacheStore.getState().replace(KEY, [commit(FULL(1))], 50);
    const first = useVcsCacheStore.getState().entries[KEY]!.commits;
    useVcsCacheStore.getState().replace(KEY, [commit(FULL(1))], 50);
    expect(useVcsCacheStore.getState().entries[KEY]!.commits).toBe(first);
    useVcsCacheStore.getState().replace(KEY, [commit(FULL(2))], 50);
    expect(useVcsCacheStore.getState().entries[KEY]!.commits).not.toBe(first);
  });

  it("applyHead with a lower or equal rev is ignored; a higher rev is stored and marks the worktree stale", () => {
    useVcsCacheStore.getState().replace(KEY, [commit(FULL(1))], 50);
    useVcsCacheStore.getState().applyHead("wt1", "a", "b", 10);
    expect(useVcsCacheStore.getState().entries[KEY]!.stale).toBe(true);
    useVcsCacheStore.getState().replace(KEY, [commit(FULL(1))], 50);
    expect(useVcsCacheStore.getState().entries[KEY]!.stale).toBe(false);
    useVcsCacheStore.getState().applyHead("wt1", "a", "b", 10);
    expect(useVcsCacheStore.getState().entries[KEY]!.stale).toBe(false);
    useVcsCacheStore.getState().applyHead("wt1", "a", "b", 9);
    expect(useVcsCacheStore.getState().entries[KEY]!.stale).toBe(false);
    expect(useVcsCacheStore.getState().headRevByWorktree.wt1).toBe(10);
  });

  it("applyHead marks only that worktree's entries stale", () => {
    const other = vcsKey("worktree", "wt2");
    const project = vcsKey("project", "wt1");
    useVcsCacheStore.getState().replace(KEY, [], 50);
    useVcsCacheStore.getState().replace(other, [], 50);
    useVcsCacheStore.getState().replace(project, [], 50);
    useVcsCacheStore.getState().applyHead("wt1", null, null, 1);
    const st = useVcsCacheStore.getState().entries;
    expect(st[KEY]!.stale).toBe(true);
    expect(st[other]!.stale).toBe(false);
    expect(st[project]!.stale).toBe(false);
  });

  it("markAllStale marks every entry", () => {
    const other = vcsKey("worktree", "wt2");
    useVcsCacheStore.getState().replace(KEY, [], 50);
    useVcsCacheStore.getState().replace(other, [], 50);
    useVcsCacheStore.getState().markAllStale();
    const st = useVcsCacheStore.getState().entries;
    expect(st[KEY]!.stale).toBe(true);
    expect(st[other]!.stale).toBe(true);
  });

  it("per-sha LRU evicts the 201st sha and only caches full 40-hex shas", () => {
    expect(MAX_SHAS).toBe(200);
    setShaFiles(KEY, FULL(0), []);
    for (let i = 1; i <= MAX_SHAS; i += 1) setShaFiles(KEY, FULL(i), []);
    expect(getShaFiles(KEY, FULL(0))).toBeUndefined();
    expect(getShaFiles(KEY, FULL(MAX_SHAS))).toEqual([]);

    setShaDiff(KEY, "abc1234", "a.ts", "diff");
    expect(getShaDiff(KEY, "abc1234", "a.ts")).toBeUndefined();
    setShaDiff(KEY, FULL(500), "a.ts", "diff");
    expect(getShaDiff(KEY, FULL(500), "a.ts")).toBe("diff");
  });

  it("touching a sha keeps it resident (LRU, not FIFO)", () => {
    setShaFiles(KEY, FULL(0), []);
    for (let i = 1; i < MAX_SHAS; i += 1) setShaFiles(KEY, FULL(i), []);
    expect(getShaFiles(KEY, FULL(0))).toEqual([]); // touch the oldest
    setShaFiles(KEY, FULL(MAX_SHAS), []); // evicts the new oldest (FULL(1))
    expect(getShaFiles(KEY, FULL(0))).toEqual([]);
    expect(getShaFiles(KEY, FULL(1))).toBeUndefined();
  });
});
