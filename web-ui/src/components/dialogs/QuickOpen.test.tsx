import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createMockApi } from "@/api/mock";
import type { ApiInstance } from "@/api";
import type { FileScope } from "@/api/types";
import { QuickOpen } from "./QuickOpen";
import { useWorkspaceStore } from "@/hooks/useStore";

async function setup(
  api: ApiInstance,
  props: { worktreeId?: string | null; scope?: FileScope } = {},
) {
  const onClose = vi.fn();
  render(
    <QuickOpen
      api={api}
      worktreeId={props.worktreeId ?? "wt-1"}
      open
      onClose={onClose}
      scope={props.scope}
    />,
  );
  return { onClose };
}

function input() {
  return screen.getByRole("searchbox") as HTMLInputElement;
}

describe("QuickOpen", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      activeFilePath: null,
      openFileTabsByWorktree: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("5.T1: typing a plain query calls fileSearch and renders returned files", async () => {
    const api = createMockApi();
    const fileSearch = vi
      .spyOn(api, "fileSearch")
      .mockResolvedValue({ files: ["src/main.ts", "src/helper.ts"], truncated: false });

    await setup(api);

    fireEvent.change(input(), { target: { value: "main" } });

    await waitFor(() => {
      expect(fileSearch).toHaveBeenCalledWith("wt-1", "main", 50, expect.any(AbortSignal));
    });
    expect(await screen.findByText("main.ts")).toBeInTheDocument();
    expect(screen.getByText("helper.ts")).toBeInTheDocument();
  });

  it("5.T2: typing :43 shows the Go to line chip, fetches no search, and Enter jumps in the active file", async () => {
    const api = createMockApi();
    const fileSearch = vi.spyOn(api, "fileSearch").mockResolvedValue({ files: [], truncated: false });
    vi.spyOn(api, "getFile").mockResolvedValue("x\n".repeat(100));
    const setActiveFilePathAtLine = vi.spyOn(
      useWorkspaceStore.getState(),
      "setActiveFilePathAtLine",
    );
    useWorkspaceStore.setState({
      activeFilePath: "src/editor.ts",
      openFileTabsByWorktree: { "wt-1": ["src/editor.ts"] },
    });

    const { onClose } = await setup(api);

    fireEvent.change(input(), { target: { value: ":43" } });

    expect(fileSearch).not.toHaveBeenCalled();
    expect(screen.getByText("Go to line")).toBeInTheDocument();
    expect(screen.getByText("editor.ts")).toBeInTheDocument();
    expect(await screen.findByText("line 43")).toBeInTheDocument();

    fireEvent.keyDown(input(), { key: "Enter" });

    expect(setActiveFilePathAtLine).toHaveBeenCalledWith("wt-1", "src/editor.ts", 43);
    expect(onClose).toHaveBeenCalled();
  });

  it("5.T2b: bare ':' lists every open file; digits list the active file first, then only files long enough", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getFile").mockImplementation(async (_wt, path) =>
      path === "src/long.ts" ? "x\n".repeat(200) : "x\n".repeat(10),
    );
    const setActiveFilePathAtLine = vi.spyOn(
      useWorkspaceStore.getState(),
      "setActiveFilePathAtLine",
    );
    useWorkspaceStore.setState({
      activeFilePath: "src/short.ts",
      openFileTabsByWorktree: { "wt-1": ["src/long.ts", "src/short.ts", "src/tiny.ts"] },
    });

    const { onClose } = await setup(api);

    fireEvent.change(input(), { target: { value: ":" } });
    expect(screen.getByText("Go to line")).toBeInTheDocument();
    expect(screen.getByText("long.ts")).toBeInTheDocument();
    expect(screen.getByText("short.ts")).toBeInTheDocument();
    expect(screen.getByText("tiny.ts")).toBeInTheDocument();

    fireEvent.change(input(), { target: { value: ":150" } });
    await waitFor(() => expect(screen.getByText("line 150 of 201")).toBeInTheDocument());
    // active file first (even though it only has ~11 lines), tiny.ts excluded
    const names = Array.from(document.querySelectorAll(".quick-open-file-name")).map((n) => n.textContent);
    expect(names).toEqual(["short.ts", "long.ts"]);
    expect(screen.getByText(/only 11 lines/)).toBeInTheDocument();

    // Enter targets the top row: the active file, clamped to its length
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(setActiveFilePathAtLine).toHaveBeenCalledWith("wt-1", "src/short.ts", 11);
    expect(onClose).toHaveBeenCalled();
  });

  it("5.T3: line mode with no open files explains why and Enter is a no-op", async () => {
    const api = createMockApi();
    const setActiveFilePathAtLine = vi.spyOn(
      useWorkspaceStore.getState(),
      "setActiveFilePathAtLine",
    );

    const { onClose } = await setup(api);

    fireEvent.change(input(), { target: { value: ":42" } });

    expect(screen.getByText(/No open files/)).toBeInTheDocument();

    fireEvent.keyDown(input(), { key: "Enter" });

    expect(setActiveFilePathAtLine).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("5.T4: typing > shows the Commands chip, triggers no fetch, and Enter does nothing", async () => {
    const api = createMockApi();
    const fileSearch = vi.spyOn(api, "fileSearch").mockResolvedValue({ files: [], truncated: false });
    const fileList = vi
      .spyOn(api, "fileList")
      .mockResolvedValue({ files: [], truncated: false, source: "node" });

    const { onClose } = await setup(api);

    fireEvent.change(input(), { target: { value: ">foo" } });

    expect(fileSearch).not.toHaveBeenCalled();
    expect(fileList).not.toHaveBeenCalled();
    expect(screen.getByText("Commands")).toBeInTheDocument();
    expect(screen.getByText("No commands yet")).toBeInTheDocument();

    fireEvent.keyDown(input(), { key: "Enter" });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("5.T4b: default mode shows hints for line jump and commands; clicking a hint enters that mode", async () => {
    const api = createMockApi();
    vi.spyOn(api, "fileSearch").mockResolvedValue({ files: [], truncated: false });

    await setup(api);

    const hints = screen.getByTestId("quick-open-hints");
    expect(hints).toHaveTextContent("go to line in an open file");
    expect(hints).toHaveTextContent("commands");

    fireEvent.click(screen.getByText(/go to line in an open file/));
    expect(input().value).toBe(":");
    expect(screen.getByText("Go to line")).toBeInTheDocument();
  });

  it("5.T7: with no query, git-changed files come first ordered by most recent mtime; deleted are skipped", async () => {
    const api = createMockApi();
    vi.spyOn(api, "fileSearch").mockResolvedValue({
      files: ["src/old.ts", "src/edited-old.ts", "src/gone.ts", "src/fresh.ts"],
      truncated: false,
    });
    vi.spyOn(api, "listChangedPaths").mockResolvedValue([
      { path: "src/edited-old.ts", status: "M", mtimeMs: 1000 },
      { path: "src/fresh.ts", status: "?", mtimeMs: 3000 },
      { path: "src/gone.ts", status: "D" },
      { path: "src/added.ts", status: "A", mtimeMs: 2000 },
    ]);

    await setup(api);

    await screen.findByText("fresh.ts");
    await waitFor(() => {
      const names = Array.from(document.querySelectorAll(".quick-open-file-name")).map((n) => n.textContent);
      expect(names).toEqual(["fresh.ts", "added.ts", "edited-old.ts", "old.ts", "gone.ts"]);
    });
    expect(screen.getByText("new")).toBeInTheDocument();
    expect(screen.getByText("added")).toBeInTheDocument();
    expect(screen.getByText("modified")).toBeInTheDocument();
  });

  it("5.T7b: typing a query drops the changed-first ordering", async () => {
    const api = createMockApi();
    vi.spyOn(api, "fileSearch").mockResolvedValue({ files: ["src/a.ts", "src/b.ts"], truncated: false });
    vi.spyOn(api, "listChangedPaths").mockResolvedValue([{ path: "src/b.ts", status: "M", mtimeMs: 5 }]);

    await setup(api);
    await screen.findByText("modified");

    fireEvent.change(input(), { target: { value: "ts" } });
    await waitFor(() => {
      const names = Array.from(document.querySelectorAll(".quick-open-file-name")).map((n) => n.textContent);
      expect(names).toEqual(["a.ts", "b.ts"]);
    });
    expect(screen.queryByText("modified")).not.toBeInTheDocument();
  });

  it("5.T5: selecting a file from worktree-scope results opens it via openFileTabNew", async () => {
    const api = createMockApi();
    vi.spyOn(api, "fileSearch").mockResolvedValue({ files: ["src/App.tsx"], truncated: false });
    const openFileTabNew = vi.spyOn(useWorkspaceStore.getState(), "openFileTabNew");
    const setActiveFileTabIdx = vi.spyOn(useWorkspaceStore.getState(), "setActiveFileTabIdx");
    const setToolPanelTab = vi.spyOn(useWorkspaceStore.getState(), "setToolPanelTab");

    const { onClose } = await setup(api);

    fireEvent.change(input(), { target: { value: "app" } });

    const item = await screen.findByText("App.tsx");
    fireEvent.click(item);

    expect(openFileTabNew).toHaveBeenCalledWith("wt-1", "src/App.tsx");
    expect(setActiveFileTabIdx).not.toHaveBeenCalled();
    expect(setToolPanelTab).toHaveBeenCalledWith("files");
    expect(onClose).toHaveBeenCalled();
  });

  it("5.T5b: selecting an already-open file activates the existing tab via setActiveFileTabIdx", async () => {
    const api = createMockApi();
    vi.spyOn(api, "fileSearch").mockResolvedValue({ files: ["src/App.tsx"], truncated: false });
    useWorkspaceStore.setState({
      openFileTabsByWorktree: { "wt-1": ["src/App.tsx"] },
    });
    const openFileTabNew = vi.spyOn(useWorkspaceStore.getState(), "openFileTabNew");
    const setActiveFileTabIdx = vi.spyOn(useWorkspaceStore.getState(), "setActiveFileTabIdx");

    await setup(api);

    fireEvent.change(input(), { target: { value: "app" } });

    const item = await screen.findByText("App.tsx");
    fireEvent.click(item);

    expect(setActiveFileTabIdx).toHaveBeenCalledWith("wt-1", 0);
    expect(openFileTabNew).not.toHaveBeenCalled();
  });

  it("5.T6: project-scope Quick Open still renders a file list via the fileList + client-scoring path", async () => {
    const api = createMockApi();
    const fileList = vi
      .spyOn(api, "fileList")
      .mockResolvedValue({
        files: ["src/main.rs", "src/main_test.rs", "src/other/zz.rs"],
        truncated: false,
        source: "node",
      });
    const fileSearch = vi.spyOn(api, "fileSearch").mockResolvedValue({ files: [], truncated: false });

    await setup(api, { worktreeId: "proj-1", scope: "project" });

    fireEvent.change(input(), { target: { value: "main" } });

    await waitFor(() => {
      expect(fileList).toHaveBeenCalledWith("proj-1", expect.any(AbortSignal), "project");
    });
    expect(fileSearch).not.toHaveBeenCalled();
    expect(await screen.findByText("main.rs")).toBeInTheDocument();
    expect(screen.getByText("main_test.rs")).toBeInTheDocument();
  });

  // Regression: the daemon's file-search index only stays fresh (and only
  // survives — FileSearchIndex::evict) while some tree:watch is held for the
  // worktree. FileTreeSidebar/FilePreviewPane hold one, but only while the
  // Files tool-panel tab is active — Quick Open is reachable regardless of
  // which tab is showing, so it must hold its own watch while open.
  it("5.T7: holds its own tree:watch while open, and releases it on close (worktree scope only)", async () => {
    const api = createMockApi();
    vi.spyOn(api, "fileSearch").mockResolvedValue({ files: [], truncated: false });
    const send = vi.spyOn(api, "send");
    const onClose = vi.fn();

    const { rerender } = render(
      <QuickOpen api={api} worktreeId="wt-1" open onClose={onClose} />,
    );
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({ type: "tree:watch", worktreeId: "wt-1" }),
    );

    rerender(<QuickOpen api={api} worktreeId="wt-1" open={false} onClose={onClose} />);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({ type: "tree:unwatch", worktreeId: "wt-1" }),
    );
  });

  it("5.T7b: project scope never sends tree:watch (no daemon-side watcher there)", async () => {
    const api = createMockApi();
    vi.spyOn(api, "fileList").mockResolvedValue({ files: [], truncated: false, source: "node" });
    const send = vi.spyOn(api, "send");

    render(<QuickOpen api={api} worktreeId="proj-1" open onClose={vi.fn()} scope="project" />);
    await screen.findByPlaceholderText(/Search files by name/);

    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "tree:watch" }));
  });
});
