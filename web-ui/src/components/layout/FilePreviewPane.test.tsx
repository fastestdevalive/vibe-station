import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { GutterResult } from "@/api/types";
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

describe("FilePreviewPane — 3.T4 (scroll to pendingFileLine, from search click-through)", () => {
  it("scrolls the matching line into view and clears pendingFileLine once consumed", async () => {
    const api = createMockApi();
    // "src/App.tsx" mock content is 3 lines (see mock.ts fileContents):
    //   1: export function App() {
    //   2:   return <div>hello</div>;
    //   3: }
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.tsx",
      diffScopeByWorktree: {},
      pendingFileLine: null,
    });
    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => expect(container.querySelector(".workspace-code-viewer")).toBeTruthy());

    const scrollSpy = vi.fn();
    // Stub scrollIntoView per-element (the global jsdom polyfill in
    // src/test/setup.ts is a shared no-op, not a spy we can assert on).
    for (const el of container.querySelectorAll(".workspace-code-line")) {
      (el as HTMLElement).scrollIntoView = scrollSpy;
    }

    act(() => {
      useWorkspaceStore.setState({ pendingFileLine: 2 });
    });

    await waitFor(() => expect(scrollSpy).toHaveBeenCalledWith({ block: "center" }));

    // The line whose gutter reads "2" is the one that was scrolled to.
    const lines = Array.from(container.querySelectorAll(".workspace-code-line"));
    const line2 = lines.find(
      (el) => el.querySelector(".workspace-code-gutter")?.textContent?.trim() === "2",
    );
    expect(line2?.scrollIntoView).toHaveBeenCalledWith({ block: "center" });

    // Consumed — cleared back to null so a later render doesn't re-scroll.
    await waitFor(() => expect(useWorkspaceStore.getState().pendingFileLine).toBeNull());
  });

  it("does not scroll when pendingFileLine is null", async () => {
    const api = createMockApi();
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.tsx",
      diffScopeByWorktree: {},
      pendingFileLine: null,
    });
    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => expect(container.querySelector(".workspace-code-viewer")).toBeTruthy());

    const scrollSpy = vi.fn();
    for (const el of container.querySelectorAll(".workspace-code-line")) {
      (el as HTMLElement).scrollIntoView = scrollSpy;
    }

    expect(scrollSpy).not.toHaveBeenCalled();
  });
});

describe("FilePreviewPane — 5.T3 (git gutter marks on modified files)", () => {
  it("shows gutter marks when getGutter returns added/modified data", async () => {
    const api = createMockApi();
    const gutterResult: GutterResult = {
      added: [2, 3],
      deleted: [],
      modified: [1],
    };
    const getGutterSpy = vi.spyOn(api, "getGutter").mockResolvedValue(gutterResult);

    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.tsx",
      diffScopeByWorktree: {},
    });
    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);

    await waitFor(() => {
      const addedLines = container.querySelectorAll(".workspace-code-line--added");
      expect(addedLines.length).toBeGreaterThan(0);
    });

    const modifiedLines = container.querySelectorAll(".workspace-code-line--modified");
    expect(modifiedLines.length).toBeGreaterThan(0);

    getGutterSpy.mockRestore();
  });

  it("shows no gutter marks when getGutter returns empty data", async () => {
    const api = createMockApi();
    const gutterResult: GutterResult = {
      added: [],
      deleted: [],
      modified: [],
    };
    const getGutterSpy = vi.spyOn(api, "getGutter").mockResolvedValue(gutterResult);

    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.tsx",
      diffScopeByWorktree: {},
    });
    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);

    await waitFor(() => expect(container.querySelector(".workspace-code-viewer")).toBeTruthy());

    const markedLines = container.querySelectorAll(".workspace-code-line--added, .workspace-code-line--modified, .workspace-code-line--deleted");
    expect(markedLines.length).toBe(0);

    getGutterSpy.mockRestore();
  });
});

describe("FilePreviewPane — 5.T4 (markdown raw-view toggle)", () => {
  it("rendered markdown view shows no gutter marks", async () => {
    const api = createMockApi();
    const gutterResult: GutterResult = {
      added: [1, 2],
      deleted: [],
      modified: [],
    };
    const getGutterSpy = vi.spyOn(api, "getGutter").mockResolvedValue(gutterResult);

    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "README.md",
      diffScopeByWorktree: {},
    });
    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Demo" })).toBeInTheDocument();
    });

    // Rendered markdown view should never show gutter marks (MarkdownView != CodeView)
    const markedLines = container.querySelectorAll(".workspace-code-line--added, .workspace-code-line--modified");
    expect(markedLines.length).toBe(0);

    getGutterSpy.mockRestore();
  });

  it("toggling to raw markdown view shows gutter marks in CodeView with code chrome", async () => {
    const api = createMockApi();
    const gutterResult: GutterResult = {
      added: [1, 2],
      deleted: [],
      modified: [],
    };
    const getGutterSpy = vi.spyOn(api, "getGutter").mockResolvedValue(gutterResult);

    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "README.md",
      diffScopeByWorktree: {},
    });
    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);

    // Wait for rendered markdown view
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Demo" })).toBeInTheDocument();
    });

    // Before toggle: no gutter marks, no code chrome
    expect(container.querySelectorAll(".workspace-code-line--added").length).toBe(0);
    const previewBody = container.querySelector(".preview-body");
    expect(previewBody?.className).not.toContain("preview-body--code");

    // Click the Source/Formatted toggle button
    const toggleButton = screen.getByRole("button", { name: /View source|View rendered markdown/ });
    await userEvent.click(toggleButton);

    // After toggle: gutter marks should appear, code chrome should be applied
    await waitFor(() => {
      const addedLines = container.querySelectorAll(".workspace-code-line--added");
      expect(addedLines.length).toBeGreaterThan(0);
    });

    // preview-body--code class should be present for code chrome
    const updatedPreviewBody = container.querySelector(".preview-body");
    expect(updatedPreviewBody?.className).toContain("preview-body--code");

    getGutterSpy.mockRestore();
  });
});

