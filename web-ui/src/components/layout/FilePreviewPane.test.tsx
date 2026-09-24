import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
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

  it("project-scope plain preview fetches the local diff too (for the diff-stat strip), scoped to the project", async () => {
    // `GET /projects/:id/diff/*path?scope=local` exists (same route this
    // feature added for diff mode) — plain preview must use it, same as
    // worktree scope, not skip it. Previously this call was unconditionally
    // skipped for project scope, so diffStats fell back to a synthetic
    // "whole file is new" computation regardless of the file's real status.
    const getDiffSpy = vi.spyOn(api, "getDiff").mockResolvedValue("diff --git a/README.md b/README.md\n");
    useWorkspaceStore.setState({
      activeWorktreeId: "proj-1",
      activeFilePath: "README.md",
      diffScopeByWorktree: {},
    });
    render(<FilePreviewPane api={api} worktreeId="proj-1" scope="project" />);

    await waitFor(() => {
      expect(getDiffSpy).toHaveBeenCalledWith("proj-1", "README.md", "local", undefined, "project");
    });

    getDiffSpy.mockRestore();
  });

  it("project-scope diff mode (Files header's toggle) actually renders a diff — the fix for the toggle being reachable but silently inert", async () => {
    // Regression guard: FilePreviewPane used to force scope to "none" for
    // any fileScope === "project" REGARDLESS of diffScopeByWorktree, so
    // FileTreeHeader's diff-view toggle turned the store slice to "local"
    // but the pane never noticed — clicking a changed file opened it as a
    // plain, undecorated file. `getDiff`'s project-scope threading already
    // existed (see the other project-scope tests in this file); the bug was
    // purely that `scope` never actually became "local" here.
    //
    // Also covers a second, sibling bug found in manual testing: the
    // "Compared to HEAD" label (asserted below) renders from `scope` alone,
    // regardless of whether the fetch actually succeeds — it does NOT prove
    // `getFile` was called correctly. `getFile(worktreeId, path)` in the
    // scope==="local" branch was missing its `fileScope` arg entirely
    // (unlike `getDiff`, right next to it), defaulting to "worktree" and
    // 404ing against the mock's worktree-only lookup ("Worktree '<id>' not
    // found" in the real daemon) — so this test also asserts the file body
    // actually rendered, which only happens if `getFile` succeeded.
    const getFileSpy = vi.spyOn(api, "getFile");
    const getDiffSpy = vi.spyOn(api, "getDiff").mockResolvedValue("diff --git a/README.md b/README.md\n");
    useWorkspaceStore.setState({
      activeWorktreeId: "proj-1",
      activeFilePath: "README.md",
      diffScopeByWorktree: { "proj-1": "local" },
    });
    render(<FilePreviewPane api={api} worktreeId="proj-1" scope="project" />);

    await waitFor(() => {
      expect(getFileSpy).toHaveBeenCalledWith("proj-1", "README.md", "project");
      expect(getDiffSpy).toHaveBeenCalledWith("proj-1", "README.md", "local", undefined, "project");
    });
    expect(await screen.findByText("Compared to HEAD")).toBeInTheDocument();
    // `Promise.all([getFile, getDiff])` rejects as a whole if EITHER call
    // rejects, which flips the pane into its generic error state (a bare
    // `.empty-state` div showing the thrown message) instead of rendering
    // `.preview-body--code`/DiffView — the mock's getFile 404s
    // ("not found") for an unscoped call against a non-worktree id, exactly
    // like the real daemon's "Worktree '<id>' not found". If getFile were
    // still missing its `fileScope` arg, this assertion (not just the
    // scope-only "Compared to HEAD" label above) is what would catch it.
    await waitFor(() => {
      expect(document.querySelector(".preview-body")).toBeInTheDocument();
    });
    expect(screen.queryByText(/not found/i)).not.toBeInTheDocument();

    getFileSpy.mockRestore();
    getDiffSpy.mockRestore();
  });

  it("project-scope branch-scope getFile also threads fileScope (defensive — unreachable from the UI today, chips are hidden for project scope)", async () => {
    const getFileSpy = vi.spyOn(api, "getFile");
    const getDiffSpy = vi.spyOn(api, "getDiff").mockResolvedValue("diff --git a/README.md b/README.md\n");
    useWorkspaceStore.setState({
      activeWorktreeId: "proj-1",
      activeFilePath: "README.md",
      diffScopeByWorktree: { "proj-1": "branch" },
    });
    render(<FilePreviewPane api={api} worktreeId="proj-1" scope="project" />);

    await waitFor(() => {
      expect(getFileSpy).toHaveBeenCalledWith("proj-1", "README.md", "project");
      expect(getDiffSpy).toHaveBeenCalledWith("proj-1", "README.md", "branch", undefined, "project");
    });

    getFileSpy.mockRestore();
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

  it("3.T6 — project-scope controlled commit mode threads fileScope into the getDiff call", async () => {
    const api = createMockApi();
    const getDiffSpy = vi.spyOn(api, "getDiff").mockResolvedValue("diff --git a/src/App.tsx b/src/App.tsx\n");
    useWorkspaceStore.setState({
      activeWorktreeId: "proj-1",
      activeFilePath: "src/App.tsx",
      diffScopeByWorktree: {},
    });

    render(
      <FilePreviewPane
        api={api}
        worktreeId="proj-1"
        scope="project"
        controlled={{ path: "src/App.tsx", scope: "commit", commitSha: "abc123" }}
      />,
    );
    await waitFor(() => {
      expect(getDiffSpy).toHaveBeenCalledWith("proj-1", "src/App.tsx", "commit", "abc123", "project");
    });

    getDiffSpy.mockRestore();
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

describe("FilePreviewPane — 3.T4 (scroll to pendingLineTarget, from search click-through)", () => {
  it("scrolls the matching line into view and highlights it; the target persists (not cleared) once consumed", async () => {
    const api = createMockApi();
    // "src/App.tsx" mock content is 3 lines (see mock.ts fileContents):
    //   1: export function App() {
    //   2:   return <div>hello</div>;
    //   3: }
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.tsx",
      diffScopeByWorktree: {},
      pendingLineTarget: null,
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
      useWorkspaceStore.setState({
        pendingLineTarget: { worktreeId: "wt-1", path: "src/App.tsx", line: 2, matchText: null },
      });
    });

    await waitFor(() => expect(scrollSpy).toHaveBeenCalledWith({ block: "center" }));

    // The line whose gutter reads "2" is the one that was scrolled to, and it
    // carries the line-highlight class.
    const lines = Array.from(container.querySelectorAll(".workspace-code-line"));
    const line2 = lines.find(
      (el) => el.querySelector(".workspace-code-gutter")?.textContent?.trim() === "2",
    );
    expect(line2?.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(line2).toHaveClass("workspace-code-line--target");

    // Deliberately NOT cleared once consumed (unlike the old `pendingFileLine`
    // self-clearing design) — the target/highlight persists for as long as the
    // user is viewing that exact file, so live-review feedback ("the highlight
    // should show when the file opens") holds true, not just for one frame.
    await waitFor(() =>
      expect(useWorkspaceStore.getState().pendingLineTarget).toEqual({
        worktreeId: "wt-1",
        path: "src/App.tsx",
        line: 2,
        matchText: null,
      }),
    );
  });

  it("scrolls a diff-mode (DiffView) render too — regression: DiffView's .diff-line/.diff-gutter markup used to never match the old gutter-text-only lookup", async () => {
    const api = createMockApi();
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.tsx",
      diffScopeByWorktree: { "wt-1": "local" },
      pendingLineTarget: null,
    });
    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => expect(container.querySelector(".diff-line")).toBeTruthy());
    // Confirm this render is really DiffView, not CodeView (else the test
    // wouldn't be exercising the regression at all).
    expect(container.querySelector(".workspace-code-line")).toBeNull();

    const scrollSpy = vi.fn();
    for (const el of container.querySelectorAll(".diff-line")) {
      (el as HTMLElement).scrollIntoView = scrollSpy;
    }

    act(() => {
      useWorkspaceStore.setState({
        pendingLineTarget: { worktreeId: "wt-1", path: "src/App.tsx", line: 2, matchText: null },
      });
    });

    await waitFor(() => expect(scrollSpy).toHaveBeenCalledWith({ block: "center" }));
    const target = container.querySelector('[data-line="2"]');
    expect(target?.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });

  it("renders the line-highlight AND matched-text mark end-to-end when pendingLineTarget carries matchText", async () => {
    const api = createMockApi();
    // "src/App.tsx" line 2 is `  return <div>hello</div>;` (mock.ts fileContents).
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.tsx",
      diffScopeByWorktree: {},
      pendingLineTarget: { worktreeId: "wt-1", path: "src/App.tsx", line: 2, matchText: "hello" },
    });
    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => expect(container.querySelector(".workspace-code-viewer")).toBeTruthy());

    await waitFor(() => {
      const mark = container.querySelector("mark.workspace-code-match");
      expect(mark).toBeTruthy();
      expect(mark?.textContent).toBe("hello");
    });
    const lines = Array.from(container.querySelectorAll(".workspace-code-line"));
    const line2 = lines.find(
      (el) => el.querySelector(".workspace-code-gutter")?.textContent?.trim() === "2",
    );
    expect(line2).toHaveClass("workspace-code-line--target");
  });

  it("does not scroll when pendingLineTarget is null", async () => {
    const api = createMockApi();
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.tsx",
      diffScopeByWorktree: {},
      pendingLineTarget: null,
    });
    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => expect(container.querySelector(".workspace-code-viewer")).toBeTruthy());

    const scrollSpy = vi.fn();
    for (const el of container.querySelectorAll(".workspace-code-line")) {
      (el as HTMLElement).scrollIntoView = scrollSpy;
    }

    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("highlights the jumped-to line, removing the highlight after 5s (and never leaves two lines highlighted at once)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = createMockApi();
      useWorkspaceStore.setState({
        activeWorktreeId: "wt-1",
        activeFilePath: "src/App.tsx",
        diffScopeByWorktree: {},
        pendingLineTarget: null,
      });
      const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);
      await vi.waitFor(() => expect(container.querySelector(".workspace-code-viewer")).toBeTruthy());

      act(() => {
        useWorkspaceStore.setState({
          pendingLineTarget: { worktreeId: "wt-1", path: "src/App.tsx", line: 2, matchText: null },
        });
      });
      await vi.waitFor(() => expect(container.querySelector('[data-line="2"]')).toHaveClass("workspace-line-highlight"));

      const line2 = container.querySelector('[data-line="2"]');
      expect(line2).toHaveClass("workspace-line-highlight");
      expect(container.querySelectorAll(".workspace-line-highlight")).toHaveLength(1);

      // A second jump before the first highlight expires moves the highlight,
      // never leaving two lines lit at once.
      act(() => {
        useWorkspaceStore.setState({
          pendingLineTarget: { worktreeId: "wt-1", path: "src/App.tsx", line: 1, matchText: null },
        });
      });
      await vi.waitFor(() => expect(container.querySelector('[data-line="1"]')).toHaveClass("workspace-line-highlight"));
      expect(container.querySelector('[data-line="1"]')).toHaveClass("workspace-line-highlight");
      expect(container.querySelectorAll(".workspace-line-highlight")).toHaveLength(1);

      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(container.querySelectorAll(".workspace-line-highlight")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
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

  it("markdown files have no source/rendered toggle — plain mode is always rendered", async () => {
    const api = createMockApi();
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "README.md",
      diffScopeByWorktree: {},
    });
    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Demo" })).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: /View source|View rendered markdown/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Source")).not.toBeInTheDocument();
    expect(screen.queryByText("Formatted")).not.toBeInTheDocument();
    expect(container.querySelector(".preview-body")?.className).not.toContain("preview-body--code");
  });

  it("markdown file with git diff enabled shows the diff, not the rendered preview, and no toggle", async () => {
    const api = createMockApi();
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "README.md",
      diffScopeByWorktree: { "wt-1": "branch" },
    });
    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);

    await waitFor(() => {
      expect(screen.getByText("Compared to fork base")).toBeInTheDocument();
    });

    expect(screen.queryByRole("heading", { name: "Demo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /View source|View rendered markdown/ })).not.toBeInTheDocument();
    expect(container.querySelector(".preview-body")?.className).toContain("preview-body--code");
  });
});

// File-watch leak fix, Phase 4 — catch-up refetch on a genuine WS reconnect.
// While a file is open and the user doesn't navigate away, the only thing
// that refreshes it is a `file:changed` push — lost across a socket drop
// until the client replays the watch. `ws:open` (emitted by client.ts only
// AFTER that replay is sent) triggers one extra fetch to catch up on
// whatever changed during the disconnected window.
describe("FilePreviewPane — file-watch leak fix Phase 4 (ws:open catch-up refetch)", () => {
  it("does not refetch on the FIRST ws:open (mount already fetched fresh) but does on the SECOND (a real reconnect)", async () => {
    const api = createMockApi();
    const getFileSpy = vi.spyOn(api, "getFile").mockResolvedValue("content");
    const onSpy = vi.spyOn(api, "on");
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.tsx",
      diffScopeByWorktree: {},
    });

    render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => expect(getFileSpy).toHaveBeenCalledTimes(1));

    const wsOpenCall = onSpy.mock.calls.find(([type]) => type === "ws:open");
    expect(wsOpenCall, "FilePreviewPane must subscribe to ws:open").toBeTruthy();
    const handler = wsOpenCall![1];

    // First ws:open — the initial connect. Already covered by the mount
    // fetch above; must NOT trigger a redundant extra fetch.
    act(() => {
      handler({ type: "ws:open" });
    });
    await Promise.resolve();
    expect(getFileSpy).toHaveBeenCalledTimes(1);

    // Second ws:open — an actual reconnect. Must trigger a fresh catch-up
    // fetch, since content may have changed during the disconnected window.
    act(() => {
      handler({ type: "ws:open" });
    });
    await waitFor(() => expect(getFileSpy).toHaveBeenCalledTimes(2));
  });
});

describe("FilePreviewPane — Phase 2 peekFile (B3 precedence + B2 consumed-tracking)", () => {
  it("renders peekFile's path when set and worktreeId matches, even though activeFilePath points elsewhere", async () => {
    const api = createMockApi();
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.tsx",
      diffScopeByWorktree: {},
      peekFile: { worktreeId: "wt-1", path: "README.md", line: 1, matchText: null, source: "search" },
    });
    render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    // Peek (README.md) wins over activeFilePath (src/App.tsx) when context-matched.
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Demo" })).toBeInTheDocument();
    });
  });

  it("falls back to activeFilePath when peekFile is null", async () => {
    const api = createMockApi();
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.tsx",
      diffScopeByWorktree: {},
      peekFile: null,
    });
    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => expect(container.querySelector(".workspace-code-viewer")).toBeTruthy());
  });

  it("falls back to activeFilePath when peekFile.worktreeId doesn't match this pane's worktreeId (B3)", async () => {
    const api = createMockApi();
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.tsx",
      diffScopeByWorktree: {},
      // Peek is for a DIFFERENT worktree — must not leak into this pane.
      peekFile: { worktreeId: "wt-2", path: "README.md", line: 1, matchText: null, source: "search" },
    });
    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    // Shows App.tsx (activeFilePath), NOT README.md (mismatched peek).
    await waitFor(() => expect(container.querySelector(".workspace-code-viewer")).toBeTruthy());
    expect(screen.queryByRole("heading", { name: "Demo" })).not.toBeInTheDocument();
  });

  it("controlled mode ignores peekFile entirely (peek never leaks into VcsCommitView)", async () => {
    const api = createMockApi();
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.tsx",
      diffScopeByWorktree: {},
      peekFile: { worktreeId: "wt-1", path: "README.md", line: 1, matchText: null, source: "search" },
    });
    render(
      <FilePreviewPane
        api={api}
        worktreeId="wt-1"
        controlled={{ path: "src/App.tsx", scope: "commit", commitSha: "abc123" }}
      />,
    );
    await waitFor(() => expect(screen.getByText("Commit diff")).toBeInTheDocument());
  });

  it("a peek-sourced scroll-to-line does not re-fire on an unrelated re-render once consumed (B2)", async () => {
    // Regression coverage note: this used to toggle the markdown raw/formatted
    // view (since removed from the component entirely) to force a re-render
    // without changing the peek's `path#line` key. Re-setting `peekFile` to
    // the exact same value is a more direct trigger for the same scenario —
    // "some unrelated state change causes a re-render; the already-consumed
    // key must not re-fire the scroll".
    const api = createMockApi();
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "README.md",
      diffScopeByWorktree: {},
      peekFile: { worktreeId: "wt-1", path: "README.md", line: 1, matchText: null, source: "search" },
      pendingLineTarget: null,
    });
    render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Demo" })).toBeInTheDocument());

    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");
    try {
      // Markdown's rendered view has no `.workspace-code-line` elements, so the
      // initial peek scroll can't have fired yet — nothing to assert there.
      expect(scrollSpy).not.toHaveBeenCalled();

      // Re-set peekFile to the SAME value — a re-render with an unchanged key.
      // Must not (re-)fire a scroll, since there's still no matching line
      // element on screen (rendered Markdown never grows one for this key).
      act(() => {
        useWorkspaceStore.setState({
          peekFile: { worktreeId: "wt-1", path: "README.md", line: 1, matchText: null, source: "search" },
        });
      });
      await Promise.resolve();
      expect(scrollSpy).not.toHaveBeenCalled();
    } finally {
      scrollSpy.mockRestore();
    }
  });

  it("B-1 — crossing to a new file at the SAME line number re-arms the scroll", async () => {
    const api = createMockApi();
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.tsx",
      diffScopeByWorktree: {},
      peekFile: { worktreeId: "wt-1", path: "src/App.tsx", line: 1, matchText: null, source: "search" },
      pendingLineTarget: null,
    });
    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => expect(container.querySelector(".workspace-code-viewer")).toBeTruthy());

    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");
    try {
      // Move the peek to a DIFFERENT file at the SAME line number (1). The line
      // VALUE doesn't change (still 1), but the path does — this must re-arm the
      // scroll (B-1); previously the path-capture effect only keyed on the line
      // value, so it never re-ran and the stale-path guard silently dropped the
      // scroll in the new file.
      act(() => {
        useWorkspaceStore.setState({
          peekFile: { worktreeId: "wt-1", path: "src/main.tsx", line: 1, matchText: null, source: "search" },
        });
      });

      // main.tsx (single line, gutter "1") must actually be scrolled to.
      await waitFor(() => {
        const lines = Array.from(container.querySelectorAll(".workspace-code-line"));
        const mainLine = lines.find(
          (el) => el.querySelector(".workspace-code-gutter")?.textContent?.trim() === "1",
        );
        expect(mainLine?.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
      });
    } finally {
      scrollSpy.mockRestore();
    }
  });

  it("B-2 — arrowing back UP to an already-visited line re-scrolls to it", async () => {
    const api = createMockApi();
    // A file with enough lines (1..40) so the multi-line peek scenario works.
    const body = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const getFileSpy = vi.spyOn(api, "getFile").mockResolvedValue(body);

    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/Big.ts",
      diffScopeByWorktree: {},
      peekFile: null,
      pendingLineTarget: null,
    });
    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => expect(container.querySelector(".workspace-code-viewer")).toBeTruthy());

    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");
    try {
      const goto = (line: number) => {
        act(() => {
          useWorkspaceStore.setState({ peekFile: { worktreeId: "wt-1", path: "src/Big.ts", line, matchText: null, source: "search" } });
        });
      };

      // Arrow down through three matches: line 10, then 20, then 35.
      goto(10);
      await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(1));
      goto(20);
      await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(2));
      goto(35);
      await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(3));

      // Arrow back UP to line 10 — already visited (still in the last-scrolled
      // history), but the request key changed away and back, so it MUST
      // re-scroll (B-2). The old accumulating Set never forgot `path#10`, so it
      // stayed parked at line 35.
      scrollSpy.mockClear();
      goto(10);
      await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(1));

      const lines = Array.from(container.querySelectorAll(".workspace-code-line"));
      const line10 = lines.find(
        (el) => el.querySelector(".workspace-code-gutter")?.textContent?.trim() === "10",
      );
      expect(line10?.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    } finally {
      scrollSpy.mockRestore();
      getFileSpy.mockRestore();
    }
  });
});

describe("FilePreviewPane — 2.9 (back/forward buttons and keyboard shortcuts)", () => {
  const api = createMockApi();

  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.tsx",
      diffScopeByWorktree: {},
      peekFile: null,
      backStack: {},
      forwardStack: {},
    });
  });

  it("renders back and forward buttons disabled when stacks are empty", async () => {
    render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled();
    });
  });

  it("enables back button when backStack has entries and triggers navigateBack on click", async () => {
    const navigateBackSpy = vi.fn();
    useWorkspaceStore.setState({
      backStack: {
        "wt-1": [
          {
            kind: "committed",
            worktreeId: "wt-1",
            path: "README.md",
            line: null,
          },
        ],
      },
      navigateBack: navigateBackSpy,
    });

    render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    const backBtn = await screen.findByRole("button", { name: "Back" });
    expect(backBtn).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled();

    backBtn.click();
    expect(navigateBackSpy).toHaveBeenCalledWith("wt-1");
  });

  it("enables forward button when forwardStack has entries and triggers navigateForward on click", async () => {
    const navigateForwardSpy = vi.fn();
    useWorkspaceStore.setState({
      forwardStack: {
        "wt-1": [
          {
            kind: "committed",
            worktreeId: "wt-1",
            path: "README.md",
            line: null,
          },
        ],
      },
      navigateForward: navigateForwardSpy,
    });

    render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    const fwdBtn = await screen.findByRole("button", { name: "Forward" });
    expect(fwdBtn).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();

    fwdBtn.click();
    expect(navigateForwardSpy).toHaveBeenCalledWith("wt-1");
  });

  it("keyboard shortcuts Alt+Shift+ArrowLeft and Alt+Shift+ArrowRight trigger back and forward navigation", async () => {
    const navigateBackSpy = vi.fn();
    const navigateForwardSpy = vi.fn();
    useWorkspaceStore.setState({
      backStack: {
        "wt-1": [
          {
            kind: "committed",
            worktreeId: "wt-1",
            path: "README.md",
            line: null,
          },
        ],
      },
      forwardStack: {
        "wt-1": [
          {
            kind: "committed",
            worktreeId: "wt-1",
            path: "src/App.tsx",
            line: null,
          },
        ],
      },
      navigateBack: navigateBackSpy,
      navigateForward: navigateForwardSpy,
    });

    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    const pane = container.querySelector(".preview-pane") as HTMLElement;
    expect(pane).toBeTruthy();

    // Alt+Shift+ArrowLeft triggers navigateBack
    act(() => {
      fireEvent.keyDown(pane, {
        key: "ArrowLeft",
        altKey: true,
        shiftKey: true,
      });
    });
    expect(navigateBackSpy).toHaveBeenCalledWith("wt-1");

    // Alt+Shift+ArrowRight triggers navigateForward
    act(() => {
      fireEvent.keyDown(pane, {
        key: "ArrowRight",
        altKey: true,
        shiftKey: true,
      });
    });
    expect(navigateForwardSpy).toHaveBeenCalledWith("wt-1");
  });
});

