import { describe, it, expect, beforeEach } from "vitest";
import { useDetailsStore, type DetailsTarget } from "./detailsStore";
import { resolveCopyPath, resolveRelativePath } from "./copyPath";
import type { ArtifactRow, FileStat } from "@/api/types";

const fileTarget: DetailsTarget = { scope: "worktree", scopeId: "wt1", path: "web-ui/a.ts", name: "a.ts" };
const artifact = {
  id: "a1",
  path: "/Users/x/out/report.html",
  displayPath: "~/out/report.html",
  inRepo: false,
} as unknown as ArtifactRow;
const artifactTarget: DetailsTarget = {
  scope: "worktree",
  scopeId: "wt1",
  path: "/Users/x/out/report.html",
  name: "report.html",
  artifact,
};
const statOk: FileStat = {
  path: "web-ui/a.ts",
  absolutePath: "/repo/web-ui/a.ts",
  kind: "file",
  size: 1,
  modifiedMs: 1,
  lineCount: 1,
  inRoot: true,
};

describe("detailsStore", () => {
  beforeEach(() => {
    useDetailsStore.setState({ target: null });
  });

  it("open sets the target, close clears it, a second open replaces the first", () => {
    useDetailsStore.getState().open(fileTarget);
    expect(useDetailsStore.getState().target).toEqual(fileTarget);
    useDetailsStore.getState().open(artifactTarget);
    expect(useDetailsStore.getState().target).toEqual(artifactTarget);
    useDetailsStore.getState().close();
    expect(useDetailsStore.getState().target).toBeNull();
  });
});

describe("copyPath helpers", () => {
  it("resolveCopyPath returns artifact.path for an artifact even with a stat", () => {
    expect(resolveCopyPath(artifactTarget, statOk)).toBe("/Users/x/out/report.html");
  });

  it("resolveCopyPath falls back to stat.absolutePath, then target.path", () => {
    expect(resolveCopyPath(fileTarget, statOk)).toBe("/repo/web-ui/a.ts");
    expect(resolveCopyPath(fileTarget, null)).toBe("web-ui/a.ts");
    expect(resolveCopyPath(fileTarget, { ...statOk, absolutePath: null })).toBe("web-ui/a.ts");
  });

  it("resolveRelativePath returns displayPath for artifacts, else path", () => {
    expect(resolveRelativePath(artifactTarget)).toBe("~/out/report.html");
    expect(resolveRelativePath(fileTarget)).toBe("web-ui/a.ts");
  });

  it("both helpers return strings synchronously", () => {
    expect(typeof resolveCopyPath(fileTarget)).toBe("string");
    expect(typeof resolveRelativePath(fileTarget)).toBe("string");
  });
});
