import { describe, expect, it } from "vitest";
import { collectTileIds, insertPane } from "./tiling";

describe("insertPane — degrades instead of discarding the tree", () => {
  it("appends at the root when targetLeafId is null (existing tiles survive)", () => {
    const root = insertPane(null, null, "right", "a");
    const next = insertPane(root, null, "right", "b");
    // Regression: this used to return just the new leaf, silently dropping "a".
    expect(collectTileIds(next).sort()).toEqual(["a", "b"]);
  });

  it("appends at the root when targetLeafId points at a leaf that no longer exists", () => {
    const root = insertPane(null, null, "right", "a");
    const next = insertPane(root, "leaf-that-vanished", "right", "b");
    expect(collectTileIds(next).sort()).toEqual(["a", "b"]);
  });

  it("joins an existing same-axis root split rather than nesting a new one", () => {
    let tree = insertPane(null, null, "right", "a");
    tree = insertPane(tree, null, "right", "b");
    tree = insertPane(tree, null, "right", "c");
    expect(collectTileIds(tree).sort()).toEqual(["a", "b", "c"]);
    expect(tree.type).toBe("split");
    if (tree.type === "split") {
      expect(tree.children).toHaveLength(3);
      // Sizes stay normalized as siblings are appended.
      const total = tree.sizes.reduce((s, v) => s + v, 0);
      expect(total).toBeCloseTo(1, 5);
    }
  });
});
