import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { FilePreviewPane } from "./FilePreviewPane";
import { useWorkspaceStore } from "@/hooks/useStore";

describe("FilePreviewPane — Phase 9 (diff-stat/scope-toggle in plain mode)", () => {
  const api = createMockApi();

  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.tsx",
      diffScopeByWorktree: {},
    });
  });

  it("9.T1 — scope 'none' on a modified file computes non-null diffStats from the local-diff fetch", async () => {
    render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => {
      expect(screen.getByLabelText("Diff line counts")).toBeInTheDocument();
    });
  });

  it("9.T2 — scope 'branch' on a .md file populates fileBody (not null) after the fetch effect resolves", async () => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "README.md",
      diffScopeByWorktree: { "wt-1": "branch" },
    });
    render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    // fileBody populated means the diff view has a real fallback (no
    // "Loading…" empty state) once the fetch resolves.
    await waitFor(() => {
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Compared to fork base")).toBeInTheDocument();
  });

  it("never renders the previous file's body under a new path while the new fetch is in flight", async () => {
    // Regression: the old `fileBody` used to stay on screen after `path`
    // changed, so `MarkdownView` resolved the OLD file's relative image srcs
    // against the NEW file's directory (README's `./assets/logo.png` became
    // `docs/assets/logo.png` → 404, blob revoked, image blinked out).
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "README.md",
      diffScopeByWorktree: {},
    });
    render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Demo" })).toBeInTheDocument();
    });

    const getFileSpy = vi.spyOn(api, "getFile").mockImplementation(() => new Promise(() => {}));
    act(() => {
      useWorkspaceStore.setState({ activeFilePath: "docs/GUIDE.md" });
    });
    // Stale README body must be gone immediately — not lingering under docs/.
    expect(screen.queryByRole("heading", { name: "Demo" })).not.toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    getFileSpy.mockRestore();
  });

  it("no longer renders a DiffScopeSelector in the diffInfo strip (toggle moved to FileTreeSidebar's header, single control)", async () => {
    render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => {
      // diff-stat text is still present...
      expect(screen.getByLabelText("Diff line counts")).toBeInTheDocument();
    });
    // ...but the interactive local/branch chips are gone from this pane.
    expect(screen.queryByRole("button", { name: "local" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "branch" })).not.toBeInTheDocument();
  });

  it("still reacts to scope changes made elsewhere (e.g. FileTreeSidebar's header selector) via the shared diffScopeByWorktree store slice", async () => {
    render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => {
      expect(screen.getByText("Compared to HEAD")).toBeInTheDocument();
    });
    act(() => {
      useWorkspaceStore.getState().setDiffScopeForWorktree("wt-1", "branch");
    });
    await waitFor(() => {
      expect(screen.getByText("Compared to fork base")).toBeInTheDocument();
    });
  });

  it("project-scope plain preview never calls api.getDiff (guaranteed 404 for a project id)", async () => {
    const getDiffSpy = vi.spyOn(api, "getDiff");
    useWorkspaceStore.setState({
      activeWorktreeId: "proj-1",
      activeFilePath: "README.md",
      diffScopeByWorktree: {},
    });
    render(<FilePreviewPane api={api} worktreeId="proj-1" scope="project" />);

    await waitFor(() => {
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });
    expect(getDiffSpy).not.toHaveBeenCalled();

    getDiffSpy.mockRestore();
  });

  it("controlled mode does not render the interactive scope selector", async () => {
    render(
      <FilePreviewPane
        api={api}
        worktreeId="wt-1"
        controlled={{ path: "src/App.tsx", scope: "commit", commitSha: "abc123" }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Commit diff")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "branch" })).not.toBeInTheDocument();
  });
});

describe("FilePreviewPane image files (3.T1 / TODO 2)", () => {
  it("renders a zoomable image for an image file via getFileBlob (not CodeView)", async () => {
    const api = createMockApi();
    const getFileBlobSpy = vi.spyOn(api, "getFileBlob");
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "assets/logo.png",
      diffScopeByWorktree: {},
    });
    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => expect(container.querySelector(".zoomable-media")).toBeTruthy());
    expect(getFileBlobSpy).toHaveBeenCalledWith("wt-1", "assets/logo.png", "worktree");
    expect(container.querySelector(".workspace-code-viewer")).toBeNull();
    getFileBlobSpy.mockRestore();
  });

  it("renders CodeView for a non-image file and never calls getFileBlob", async () => {
    const api = createMockApi();
    const getFileBlobSpy = vi.spyOn(api, "getFileBlob");
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.ts",
      diffScopeByWorktree: {},
    });
    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => expect(container.querySelector(".workspace-code-viewer")).toBeTruthy());
    expect(getFileBlobSpy).not.toHaveBeenCalled();
    getFileBlobSpy.mockRestore();
  });
});

