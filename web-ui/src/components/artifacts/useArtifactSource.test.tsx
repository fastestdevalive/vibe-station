import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceStore } from "@/hooks/useStore";
import { usePreviewedPath } from "@/hooks/usePreviewedPath";
import { useArtifactsStore } from "./artifactsStore";
import { useArtifactRow, useArtifactSource } from "./useArtifactSource";
import { formatBytes } from "./formatBytes";
import { makeRow } from "./testFixtures";

const S = "wt1";
const ABS = "/home/u/plan.md";

function ready(rows = [makeRow({ id: "a", path: ABS, displayPath: "~/plan.md", inRepo: false })]) {
  useArtifactsStore.getState().replace(S, "worktree", { rev: 1, cap: 500, total: rows.length, items: rows });
}

beforeEach(() => useArtifactsStore.getState().reset());

describe("useArtifactSource (8.4)", () => {
  it("is none for a relative path, for a null path and when an LSP token is set", () => {
    ready();
    expect(renderHook(() => useArtifactSource("worktree", S, "src/a.ts", false)).result.current.kind).toBe("none");
    expect(renderHook(() => useArtifactSource("worktree", S, null, false)).result.current.kind).toBe("none");
    expect(renderHook(() => useArtifactSource("worktree", S, ABS, true)).result.current.kind).toBe("none");
    expect(renderHook(() => useArtifactSource("worktree", null, ABS, false)).result.current.kind).toBe("none");
  });

  it("resolves an absolute path to its row; loading until ready, evicted only once ready with no row", () => {
    const { result } = renderHook(() => useArtifactSource("worktree", S, ABS, false));
    expect(result.current.kind).toBe("loading"); // store idle
    act(() => useArtifactsStore.getState().setLoading(S, "worktree"));
    expect(result.current.kind).toBe("loading");
    act(() => useArtifactsStore.getState().setError(S, "worktree", "boom"));
    expect(result.current).toEqual({ kind: "error", message: "boom" }); // never "loading" forever, never "evicted"
    act(() => ready());
    expect(result.current).toMatchObject({ kind: "artifact", isArtifact: true, row: { id: "a" } });
    act(() => ready([]));
    expect(result.current.kind).toBe("evicted");
  });

  it("keeps a stable result across unrelated store churn (notices, other rows)", () => {
    ready();
    const { result } = renderHook(() => useArtifactSource("worktree", S, ABS, false));
    const first = result.current;
    act(() =>
      useArtifactsStore.getState().applyUpserted({
        scopeId: S,
        rev: 2,
        rows: [{ ...makeRow({ id: "other", path: "/x/other.md" }), created: false }],
      }),
    );
    expect(result.current).toBe(first);
  });

  it("a moved row (same id, new path) is followed by path", () => {
    ready();
    const { result } = renderHook(() => useArtifactSource("worktree", S, "/home/u/moved.md", false));
    expect(result.current.kind).toBe("evicted");
    act(() =>
      useArtifactsStore.getState().applyUpserted({
        scopeId: S,
        rev: 2,
        rows: [{ ...makeRow({ id: "a", path: "/home/u/moved.md", displayPath: "~/moved.md", inRepo: false }), created: false }],
      }),
    );
    expect(result.current).toMatchObject({ kind: "artifact", row: { id: "a" } });
  });
});

describe("useArtifactRow", () => {
  it("finds an in-repo row by repo-relative path and an outside row only by absolute path", () => {
    ready([
      makeRow({ id: "in", path: "/repo/docs/a.md", displayPath: "docs/a.md", inRepo: true }),
      makeRow({ id: "out", path: ABS, displayPath: "~/plan.md", inRepo: false }),
    ]);
    expect(renderHook(() => useArtifactRow(S, "docs/a.md")).result.current?.id).toBe("in");
    expect(renderHook(() => useArtifactRow(S, ABS)).result.current?.id).toBe("out");
    expect(renderHook(() => useArtifactRow(S, "~/plan.md")).result.current).toBeUndefined();
    expect(renderHook(() => useArtifactRow(S, ABS, false)).result.current).toBeUndefined();
  });
});

describe("usePreviewedPath outline gate", () => {
  it("an absolute path without a token is not a working-tree view (no Outline/LSP query); a relative one is", () => {
    useWorkspaceStore.setState({ activeWorktreeId: S, activeFilePath: ABS.replace("plan.md", "plan.ts"), peekFile: null, diffScopeByWorktree: {} });
    expect(renderHook(() => usePreviewedPath(S)).result.current.isWorkingTreeView).toBe(false);
    act(() => useWorkspaceStore.setState({ activeFilePath: "src/plan.ts" }));
    expect(renderHook(() => usePreviewedPath(S)).result.current.isWorkingTreeView).toBe(true);
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [999, "999 B"],
    [1000, "1 KB"],
    [812_000, "812 KB"],
    [3_200_000, "3.2 MB"],
    [14_000_000, "14 MB"],
    [1_500_000_000, "1.5 GB"],
  ])("%d -> %s", (n, out) => expect(formatBytes(n)).toBe(out));
  it("is empty for a negative or non-finite size", () => {
    expect(formatBytes(-1)).toBe("");
    expect(formatBytes(Number.NaN)).toBe("");
  });
});
