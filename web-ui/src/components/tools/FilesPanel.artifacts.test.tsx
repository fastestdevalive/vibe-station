import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { DemoEnvProvider, DEFAULT_DEMO_ENV } from "@/context/DemoEnv";
import { FilesPanel } from "./FilesPanel";
import { useOpenFilesChanged } from "@/hooks/usePendingFileOpens";
import type { WSEvent } from "@/api/types";
import { DEFAULT_WORKTREE_LAYOUT, useWorkspaceStore } from "@/hooks/useStore";
import { useServerStore } from "@/hooks/useServerStore";
import { useArtifactsStore } from "@/components/artifacts/artifactsStore";
import { makeRow } from "@/components/artifacts/testFixtures";

const WT = "wt-1";
const OUT = "/home/u/.claude/plans/plan.md";

function renderPanel(width: number | null) {
  const api = createMockApi();
  vi.spyOn(api, "getArtifactContent").mockResolvedValue({ kind: "text", body: "# Plan" });
  const ui = <FilesPanel api={api} worktreeId={WT} />;
  return render(
    width == null ? ui : <DemoEnvProvider value={{ ...DEFAULT_DEMO_ENV, viewport: { w: width, h: 800 } }}>{ui}</DemoEnvProvider>,
  );
}

beforeEach(() => {
  useArtifactsStore.getState().reset();
  useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: true });
  useArtifactsStore.getState().replace(WT, "worktree", {
    rev: 1,
    cap: 500,
    total: 1,
    items: [makeRow({ id: "a1", scopeId: WT, path: OUT, displayPath: "~/.claude/plans/plan.md", inRepo: false, writers: ["gone"] })],
  });
  useWorkspaceStore.setState({
    activeWorktreeId: WT,
    activeFilePath: null,
    fileTreeVisible: true,
    filesLeftPaneMode: { [WT]: "artifacts" },
    openFileTabsByWorktree: {},
    activeFileTabIdxByWorktree: {},
    layoutByWorktree: { [WT]: { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "files" } },
    peekFile: null,
  });
});

describe("FilesPanel artifacts", () => {
  it("desktop: opening an outside-repo row opens a tab keyed by its absolute path and keeps the list open", async () => {
    const user = userEvent.setup();
    renderPanel(null);
    await user.click(screen.getByRole("button", { name: /Earlier/ }));
    await user.click(screen.getByText("plan.md"));
    expect(useWorkspaceStore.getState().openFileTabsByWorktree[WT]).toEqual([OUT]);
    expect(useWorkspaceStore.getState().activeFilePath).toBe(OUT);
    expect(useWorkspaceStore.getState().fileTreeVisible).toBe(true);
    expect(screen.queryByRole("button", { name: "Back to artifacts" })).not.toBeInTheDocument();
  });

  it("mobile: selecting an artifact keeps the list open, the tab bar visible, and adds a tab next to the existing ones (no 'Back to artifacts')", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({
      openFileTabsByWorktree: { [WT]: ["src/App.tsx"] },
      activeFileTabIdxByWorktree: { [WT]: 0 },
      activeFilePath: "src/App.tsx",
    });
    renderPanel(390);
    await user.click(screen.getByRole("button", { name: /Earlier/ }));
    await user.click(screen.getByText("plan.md"));

    // Same as desktop (R91): the list stays open and the file tab bar stays, with the artifact as another tab.
    expect(useWorkspaceStore.getState().fileTreeVisible).toBe(true);
    expect(useWorkspaceStore.getState().openFileTabsByWorktree[WT]).toEqual(["src/App.tsx", OUT]);
    expect(screen.queryByRole("button", { name: "Back to artifacts" })).not.toBeInTheDocument();
    const tablist = screen.getByRole("tablist", { name: "Open files" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map((t) => t.querySelector(".files-topbar__tab-name")?.textContent)).toEqual(["App.tsx", "plan.md"]);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector(".artifact-mtop")).toBeNull();
    // The tab bar keeps the shared 35px row (no taller phone bar).
    expect((document.querySelector(".files-topbar") as HTMLElement).style.height).toBe("var(--pane-row-h)");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Plan" })).toBeInTheDocument());
  });

  it.each([null, 390])("(width %s) an absolute-path artifact tab has no 'Outside project' tag and keeps the plain file icon", (width) => {
    useWorkspaceStore.setState({
      fileTreeVisible: false,
      activeFilePath: OUT,
      openFileTabsByWorktree: { [WT]: ["src/a.ts", OUT] },
      activeFileTabIdxByWorktree: { [WT]: 1 },
    });
    renderPanel(width);
    const tabs = within(screen.getByRole("tablist", { name: "Open files" })).getAllByRole("tab");
    expect(within(tabs[0]!).queryByLabelText("Outside project")).toBeNull();
    // The outside-repo state no longer marks the tab (tools-pane-rework B4.4): a plain file icon, then the name.
    expect(within(tabs[1]!).queryByLabelText("Outside project")).toBeNull();
    expect(tabs[1]!.querySelector(".files-topbar__tab-tag")).toBeNull();
    expect(tabs[1]!.querySelector("svg")).not.toBeNull();
    const name = tabs[1]!.querySelector(".files-topbar__tab-name") as HTMLElement;
    expect(name.textContent).toBe("plan.md");
    expect(tabs[1]!.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(name.nextElementSibling).toHaveClass("files-topbar__tab-close");
    // An in-repo tab keeps the file icon first.
    expect(tabs[0]!.firstElementChild?.tagName.toLowerCase()).toBe("svg");
  });

  it("R1F-05: a reordered openFiles:changed echo keeps the header and tab on the active file; scrollIntoView runs", async () => {
    const NOTE = "/tmp/note.md";
    const scroll = vi.fn();
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    useWorkspaceStore.setState({
      fileTreeVisible: false,
      activeFilePath: NOTE,
      openFileTabsByWorktree: { [WT]: [OUT, NOTE] },
      activeFileTabIdxByWorktree: { [WT]: 1 },
    });
    let echo: ((ev: WSEvent) => void) | null = null;
    const api = createMockApi();
    vi.spyOn(api, "getArtifactContent").mockResolvedValue({ kind: "text", body: "# N" });
    const echoApi = {
      ...api,
      on: (event: string, cb: (ev: WSEvent) => void) => {
        if (event === "openFiles:changed") echo = cb;
        return () => {};
      },
    } as typeof api;
    function Harness() {
      useOpenFilesChanged(echoApi);
      return <FilesPanel api={echoApi} worktreeId={WT} />;
    }
    render(
      <DemoEnvProvider value={{ ...DEFAULT_DEMO_ENV, viewport: { w: 390, h: 800 } }}>
        <Harness />
      </DemoEnvProvider>,
    );
    try {
      await screen.findByText("note.md", { selector: ".files-topbar__tab-name" });
      act(() => echo!({ type: "openFiles:changed", worktreeId: WT, paths: [NOTE, OUT] } as WSEvent));
      expect(screen.getByText("note.md", { selector: ".files-topbar__tab-name" })).toBeInTheDocument();
      expect(useWorkspaceStore.getState().activeFileTabIdxByWorktree[WT]).toBe(0);
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  it("R1F-05: the active file tab is scrolled into view", () => {
    const scroll = vi.fn();
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    useWorkspaceStore.setState({
      fileTreeVisible: false,
      activeFilePath: "src/b.ts",
      openFileTabsByWorktree: { [WT]: ["src/a.ts", "src/b.ts"] },
      activeFileTabIdxByWorktree: { [WT]: 1 },
    });
    try {
      renderPanel(null);
      expect(scroll).toHaveBeenCalled();
      expect(scroll.mock.contexts.some((c) => (c as HTMLElement).hasAttribute?.("data-active"))).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  it("R1F-03: the active tab is revealed again when the tab strip resizes (reload layout)", () => {
    const scroll = vi.fn();
    const orig = Element.prototype.scrollIntoView;
    const origRO = globalThis.ResizeObserver;
    Element.prototype.scrollIntoView = scroll;
    let fire: (() => void) | null = null;
    globalThis.ResizeObserver = class {
      constructor(cb: () => void) {
        fire = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
    useWorkspaceStore.setState({
      fileTreeVisible: false,
      activeFilePath: "src/b.ts",
      openFileTabsByWorktree: { [WT]: ["src/a.ts", "src/b.ts"] },
      activeFileTabIdxByWorktree: { [WT]: 1 },
    });
    try {
      renderPanel(null);
      expect(fire).not.toBeNull();
      scroll.mockClear();
      fire!();
      expect(scroll).toHaveBeenCalled();
      expect(scroll.mock.contexts.some((c) => (c as HTMLElement).hasAttribute?.("data-active"))).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = orig;
      globalThis.ResizeObserver = origRO;
    }
  });

  it("mobile: a normal file keeps the regular tab strip and gets no tag", () => {
    useWorkspaceStore.setState({
      fileTreeVisible: false,
      activeFilePath: "src/App.tsx",
      openFileTabsByWorktree: { [WT]: ["src/App.tsx"] },
      activeFileTabIdxByWorktree: { [WT]: 0 },
    });
    renderPanel(390);
    expect(screen.queryByRole("button", { name: "Back to artifacts" })).not.toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Open files" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Outside project")).toBeNull();
  });

  it("mobile: an evicted absolute tab keeps the tab bar and shows the evicted state", () => {
    useArtifactsStore.getState().replace(WT, "worktree", { rev: 2, cap: 500, total: 0, items: [] });
    useWorkspaceStore.setState({
      fileTreeVisible: false,
      activeFilePath: OUT,
      openFileTabsByWorktree: { [WT]: [OUT] },
      activeFileTabIdxByWorktree: { [WT]: 0 },
    });
    renderPanel(390);
    expect(screen.queryByRole("button", { name: "Back to artifacts" })).not.toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Open files" })).toBeInTheDocument();
    expect(screen.getByText("No longer an artifact")).toBeInTheDocument();
  });
});
