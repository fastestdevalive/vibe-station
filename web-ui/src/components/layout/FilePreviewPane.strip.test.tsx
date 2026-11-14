import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { useWorkspaceStore } from "@/hooks/useStore";
import { resetVcsCacheForTests } from "@/components/vcs/vcsCacheStore";
import { FilePreviewPane } from "./FilePreviewPane";

beforeEach(() => {
  useWorkspaceStore.setState({
    activeWorktreeId: "wt-1",
    activeFilePath: "src/App.tsx",
    diffScopeByWorktree: {},
    peekFile: null,
  });
});

describe("FilePreviewPane per-sha diff reuse (tools-pane-rework B2.4)", () => {
  it("opening the same file of the same full-length commit twice fetches its diff once", async () => {
    resetVcsCacheForTests();
    const sha = "a".repeat(40);
    const api = createMockApi();
    const getDiffSpy = vi.spyOn(api, "getDiff").mockResolvedValue("diff --git a/src/App.tsx b/src/App.tsx\n");
    const first = render(
      <FilePreviewPane api={api} worktreeId="wt-1" controlled={{ path: "src/App.tsx", scope: "commit", commitSha: sha }} />,
    );
    await waitFor(() => expect(getDiffSpy).toHaveBeenCalledTimes(1));
    first.unmount();
    render(<FilePreviewPane api={api} worktreeId="wt-1" controlled={{ path: "src/App.tsx", scope: "commit", commitSha: sha }} />);
    await waitFor(() => expect(document.querySelector(".file-strip--commit")).toBeTruthy());
    expect(getDiffSpy).toHaveBeenCalledTimes(1);
    getDiffSpy.mockRestore();
  });
});

describe("FilePreviewPane strip view switch (tools-pane-rework B4.3)", () => {
  it("a diff with hunks shows Inline / Side-by-side in the strip, and DiffView renders none", async () => {
    const api = createMockApi();
    const hunkDiff = "diff --git a/src/App.tsx b/src/App.tsx\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context\n";
    vi.spyOn(api, "getDiff").mockResolvedValue(hunkDiff);
    vi.spyOn(api, "getFile").mockResolvedValue("new line\ncontext\n");
    render(<FilePreviewPane api={api} worktreeId="wt-1" controlled={{ path: "src/App.tsx", scope: "commit", commitSha: "b".repeat(40) }} />);
    await waitFor(() => expect(document.querySelector(".file-strip .preview-diff-layout-toggle")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Inline" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Side-by-side" })).toBeInTheDocument();
    // DiffView itself renders no switch (the strip owns it): exactly one in the pane.
    expect(document.querySelectorAll(".preview-diff-layout-toggle")).toHaveLength(1);
  });
});
