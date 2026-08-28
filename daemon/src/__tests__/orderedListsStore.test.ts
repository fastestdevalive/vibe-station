import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

let tempDir: string;

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  return {
    dbPath: () => pathJoin(tempDir, "vibe-station.db"),
  };
});

describe("orderedListsStore", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-ordered-lists-store-test-"));
    const { _resetDbForTest } = await import("../state/db.js");
    _resetDbForTest();
  });

  afterEach(async () => {
    const { _resetDbForTest } = await import("../state/db.js");
    _resetDbForTest();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("1.T5 setOrderedList overwrites rather than appending on repeated calls", async () => {
    const { getOrderedList, setOrderedList } = await import("../state/orderedListsStore.js");
    setOrderedList("pinned-all", ["a", "b"]);
    setOrderedList("pinned-all", ["c"]);
    expect(getOrderedList("pinned-all").itemIds).toEqual(["c"]);
  });

  it("1.T6 rows for different scopeKeys are isolated (composite PK)", async () => {
    const { getOrderedList, setOrderedList } = await import("../state/orderedListsStore.js");
    setOrderedList("pinned-all", ["a"]);
    setOrderedList("workspaces:global", ["b"]);
    expect(getOrderedList("pinned-all").itemIds).toEqual(["a"]);
    expect(getOrderedList("workspaces:global").itemIds).toEqual(["b"]);
  });

  it("getOrderedList returns an empty list and null updatedAt when no row exists", async () => {
    const { getOrderedList } = await import("../state/orderedListsStore.js");
    expect(getOrderedList("pinned-all")).toEqual({ itemIds: [], updatedAt: null });
  });
});
