import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { DiffView } from "./DiffView";
import { useWorkspaceStore } from "@/hooks/useStore";
import { getActiveDiffView } from "@/preview/diffViewRegistry";

/** Multi-hunk diff text used by the layout/collapse/hover suites below —
 *  three single-line-change hunks far enough apart to have distinct headers. */
const multiHunkDiff = [
  "@@ -1,1 +1,1 @@",
  "-old0",
  "+new0",
  "@@ -10,1 +10,1 @@",
  "-old1",
  "+new1",
  "@@ -20,1 +20,1 @@",
  "-old2",
  "+new2",
].join("\n");

describe("DiffView oldText/newText prop path (4.T1)", () => {
  it("renders one removed line and one added line for a single-line change", () => {
    const { container } = render(<DiffView oldText={"a\nb"} newText={"a\nc"} />);
    const removed = container.querySelectorAll(".diff-line--removed");
    const added = container.querySelectorAll(".diff-line--added");
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(removed[0]!.textContent).toContain("b");
    expect(added[0]!.textContent).toContain("c");
  });

  it("treats an absent oldText as a brand-new file (all-added)", () => {
    const { container } = render(<DiffView newText={"line1\nline2"} />);
    const added = container.querySelectorAll(".diff-line--added");
    const removed = container.querySelectorAll(".diff-line--removed");
    expect(added).toHaveLength(2);
    expect(removed).toHaveLength(0);
  });
});

describe("DiffView regression — existing diffText/heuristic path (4.T4)", () => {
  it("still renders identically for unified-diff text with no structured diff props", () => {
    const diffText = [
      "@@ -1,2 +1,2 @@",
      " context line",
      "-old line",
      "+new line",
    ].join("\n");
    const { container } = render(<DiffView diffText={diffText} />);
    expect(container.querySelectorAll(".diff-line--removed")).toHaveLength(1);
    expect(container.querySelectorAll(".diff-line--added")).toHaveLength(1);
    expect(container.querySelectorAll(".diff-line--context")).toHaveLength(1);
  });
});

describe("DiffView Source/Rendered toggle for .md files (9.T3)", () => {
  const diffText = "@@ -1 +1,2 @@\n # Demo\n+added line\n";

  it("shows no toggle for a non-markdown file", () => {
    render(<DiffView diffText={diffText} filePath="src/App.tsx" fileContentFallback="# Demo\n" />);
    expect(screen.queryByRole("button", { name: "Rendered" })).not.toBeInTheDocument();
  });

  it("clicking Rendered shows MarkdownView output instead of raw diff text", async () => {
    const user = userEvent.setup();
    render(<DiffView diffText={diffText} filePath="README.md" fileContentFallback={"# Demo\n\nsome body text\n"} />);
    // Defaults to Source — raw diff lines are present.
    expect(screen.getByText("added line")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Rendered" }));
    // Rendered markdown heading, not the raw diff-line text.
    expect(await screen.findByRole("heading", { name: "Demo" })).toBeInTheDocument();
    expect(screen.queryByText("added line")).not.toBeInTheDocument();
  });
});

describe("diff-view-shortcuts: DiffView interactive layout/collapse/registry", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ diffLayoutMode: "inline" });
  });

  it("1.T3 — interactive renders the layout toggle whenever hunks exist; non-interactive never does", async () => {
    render(<DiffView diffText={multiHunkDiff} interactive />);
    expect(screen.getByRole("button", { name: "Inline" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Side-by-side" })).toBeInTheDocument();

    const { container } = render(<DiffView diffText={multiHunkDiff} />);
    expect(container.querySelector(".preview-diff-layout-toggle")).not.toBeInTheDocument();
    await act(async () => {});
  });

  it("Side-by-side is never disabled — no minimum pane-width gate (superseded 1.T7-1.T9: user feedback after live testing found the width gate made the toggle unusable at normal pane sizes; both columns now just fill available space and wrap instead)", async () => {
    render(<DiffView diffText={multiHunkDiff} interactive />);
    const btn = screen.getByRole("button", { name: "Side-by-side" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.title).toBeFalsy();
    await act(async () => {});
  });

  it("1.T4 — clicking Side-by-side renders a two-column container with old lines left, new lines right", async () => {
    const user = userEvent.setup();
    const { container } = render(<DiffView diffText={multiHunkDiff} interactive />);

    await user.click(screen.getByRole("button", { name: "Side-by-side" }));

    const sbs = container.querySelector(".preview-diff-side-by-side");
    expect(sbs).toBeInTheDocument();
    const removed = sbs!.querySelectorAll(".diff-line--removed");
    const added = sbs!.querySelectorAll(".diff-line--added");
    expect(removed.length).toBeGreaterThan(0);
    expect(added.length).toBeGreaterThan(0);
    expect(removed[0]!.textContent).toContain("old0");
    expect(added[0]!.textContent).toContain("new0");
  });

  it("1.T5 — clicking a hunk's caret collapses it to one summary row; clicking again re-expands", async () => {
    const user = userEvent.setup();
    const { container } = render(<DiffView diffText={multiHunkDiff} interactive />);

    const carets = container.querySelectorAll(".preview-diff-hunk-caret");
    expect(carets.length).toBe(3);
    await user.click(carets[0]!);

    expect(container.querySelectorAll(".preview-diff-hunk-collapsed")).toHaveLength(1);

    await user.click(container.querySelector(".preview-diff-hunk-caret")!);
    expect(container.querySelectorAll(".preview-diff-hunk-collapsed")).toHaveLength(0);
  });

  it("1.T10 — hover target wins over topmost-visible fallback", async () => {
    const { container } = render(<DiffView diffText={multiHunkDiff} interactive />);
    fireEvent.click(container.querySelector(".preview-diff-view")!);
    const controller = getActiveDiffView()!;

    const hunkWrappers = container.querySelectorAll(".preview-diff-hunk");
    expect(hunkWrappers).toHaveLength(3);
    // Hover fires on a body line inside hunk 2's wrapper, not just its header
    // (Decision 4 — the whole wrapper is the hover target).
    const bodyLine = hunkWrappers[2]!.querySelector(".diff-line--removed")!;
    fireEvent.mouseEnter(bodyLine);

    act(() => controller.toggleHunkAtFocus());
    expect(hunkWrappers[2]!.querySelector(".preview-diff-hunk-collapsed")).toBeInTheDocument();
    expect(hunkWrappers[0]!.querySelector(".preview-diff-hunk-collapsed")).not.toBeInTheDocument();
    await act(async () => {});
  });

  it("1.T10b — with no hover, toggles the topmost hunk visible in the scroll viewport", async () => {
    const { container } = render(
      <div className="preview-body">
        <DiffView diffText={multiHunkDiff} interactive />
      </div>,
    );
    fireEvent.click(container.querySelector(".preview-diff-view")!);
    const controller = getActiveDiffView()!;

    // jsdom's getBoundingClientRect() returns all zeros for every element by
    // default, so every hunk header's bottom (0) >= container top (0) — the
    // FIRST header in DOM order is the "topmost visible" one, matching the
    // real-world case where hunk 0 is scrolled into view at the top.
    act(() => controller.toggleHunkAtFocus());
    const hunkWrappers = container.querySelectorAll(".preview-diff-hunk");
    expect(hunkWrappers[0]!.querySelector(".preview-diff-hunk-collapsed")).toBeInTheDocument();
    await act(async () => {});
  });

  it("1.T11 — Rendered mode: toggleLayout/toggleHunkAtFocus are both no-ops", async () => {
    const user = userEvent.setup();
    const mdDiff = "@@ -1 +1,2 @@\n # Demo\n+added line\n";
    const { container } = render(
      <DiffView diffText={mdDiff} filePath="README.md" fileContentFallback={"# Demo\n\nbody\n"} interactive />,
    );
    await user.click(screen.getByRole("button", { name: "Rendered" }));

    fireEvent.click(container.querySelector(".preview-diff-view")!);
    const controller = getActiveDiffView()!;
    const layoutBefore = useWorkspaceStore.getState().diffLayoutMode;

    act(() => {
      controller.toggleLayout();
      controller.toggleHunkAtFocus();
    });
    expect(useWorkspaceStore.getState().diffLayoutMode).toBe(layoutBefore);
  });

  it("1.T12 — collapsedHunks resets when filePath changes", async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(
      <DiffView diffText={multiHunkDiff} filePath="a.ts" interactive />,
    );
    await user.click(container.querySelector(".preview-diff-hunk-caret")!);
    expect(container.querySelectorAll(".preview-diff-hunk-collapsed")).toHaveLength(1);

    rerender(<DiffView diffText={multiHunkDiff} filePath="b.ts" interactive />);
    expect(container.querySelectorAll(".preview-diff-hunk-collapsed")).toHaveLength(0);
  });

  it("1.T13 — a non-interactive instance never registers and renders no interactive controls", async () => {
    const { container } = render(<DiffView diffText={multiHunkDiff} />);
    fireEvent.click(container.querySelector(".preview-diff-view")!);
    expect(getActiveDiffView()).toBeNull();
    expect(container.querySelector(".preview-diff-layout-toggle")).not.toBeInTheDocument();
    expect(container.querySelector(".preview-diff-hunk-caret")).not.toBeInTheDocument();
    await act(async () => {});
  });

  it("1.T16 — revealLine into a collapsed hunk: expands it and reports readiness exactly once, after expansion", async () => {
    const onRevealReady = vi.fn();
    const { container, rerender } = render(<DiffView diffText={multiHunkDiff} interactive />);
    // Collapse hunk 1 (contains new-line 10) first via its caret.
    const carets = container.querySelectorAll(".preview-diff-hunk-caret");
    fireEvent.click(carets[1]!);
    expect(container.querySelectorAll(".preview-diff-hunk-collapsed")).toHaveLength(1);

    // revealLine transitions from unset -> 10, targeting a line inside the
    // now-collapsed hunk — this is what drives the expand-then-notify effect.
    rerender(<DiffView diffText={multiHunkDiff} interactive revealLine={10} onRevealReady={onRevealReady} />);

    // End state only (per implementer note 2, not an intermediate "row
    // absent" assertion): the target row exists, the hunk is no longer
    // collapsed, and onRevealReady fired exactly once — after the expand.
    expect(container.querySelector('[data-line="10"]')).toBeInTheDocument();
    expect(container.querySelectorAll(".preview-diff-hunk-collapsed")).toHaveLength(0);
    expect(onRevealReady).toHaveBeenCalledTimes(1);
    await act(async () => {});
  });
});

/** Gap fixture (diff-view-shortcuts-expand-context): one hunk covering new
 *  lines 5..6 inside a 20-line file — yields gap-start (1..4), gap-end
 *  (7..20), and no between-hunk gap. */
const gapDiff = "@@ -5,2 +5,2 @@\n context5\n context6\n";
const gapFile = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");

describe("diff-view-shortcuts-expand-context: inline gap affordance", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ diffLayoutMode: "inline" });
  });

  it("1.T3 — clicking a gap row expands it in place to real source lines; re-click collapses", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <DiffView diffText={gapDiff} fileContentFallback={gapFile} interactive />,
    );
    // gap-start + gap-end affordances render, each labeled with its line count.
    expect(container.querySelectorAll(".preview-diff-gap")).toHaveLength(2);
    expect(screen.getByText("4 lines hidden — click to expand")).toBeInTheDocument();
    expect(screen.getByText("14 lines hidden — click to expand")).toBeInTheDocument();

    // Expand gap-start (lines 1..4) — 4 plain context rows, no +/- markers.
    await user.click(screen.getByRole("button", { name: "Expand 4 hidden lines" }));
    const contextLines = container.querySelectorAll(".preview-diff-gap .diff-line--context");
    expect(contextLines.length).toBe(4);
    expect(contextLines[0]!.textContent).toContain("line1");
    expect(contextLines[3]!.textContent).toContain("line4");
    expect(container.querySelector(".preview-diff-gap .diff-marker")?.textContent).toBe(" ");

    // Re-click (now a collapse caret) restores the summary row.
    await user.click(screen.getByRole("button", { name: "Collapse 4 hidden lines" }));
    expect(container.querySelectorAll(".preview-diff-gap .diff-line--context")).toHaveLength(0);
    expect(screen.getByText("4 lines hidden — click to expand")).toBeInTheDocument();
    await act(async () => {});
  });

  it("1.T4 — revealLine into a collapsed gap auto-expands it and reports readiness", async () => {
    const onRevealReady = vi.fn();
    const { container, rerender } = render(
      <DiffView diffText={gapDiff} fileContentFallback={gapFile} interactive />,
    );
    // Target line 3 lives inside gap-start (1..4) — not inside any hunk.
    rerender(
      <DiffView
        diffText={gapDiff}
        fileContentFallback={gapFile}
        interactive
        revealLine={3}
        onRevealReady={onRevealReady}
      />,
    );
    expect(container.querySelector('[data-line="3"]')).toBeInTheDocument();
    expect(container.querySelectorAll(".preview-diff-gap .diff-line--context")).toHaveLength(4);
    expect(onRevealReady).toHaveBeenCalledTimes(1);
    await act(async () => {});
  });

  it("2.T1 — side-by-side renders gap rows spanning both columns and expands identically", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <DiffView diffText={gapDiff} fileContentFallback={gapFile} interactive />,
    );
    await user.click(screen.getByRole("button", { name: "Side-by-side" }));

    const sbs = container.querySelector(".preview-diff-side-by-side");
    expect(sbs).toBeInTheDocument();
    expect(sbs!.querySelectorAll(".preview-diff-side-by-side__gap")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Expand 4 hidden lines" }));
    // Each gap context line renders twice — identical in both columns.
    const contextCells = sbs!.querySelectorAll(".preview-diff-side-by-side__gap .diff-line--context");
    expect(contextCells.length).toBe(8);
    expect(contextCells[0]!.textContent).toContain("line1");
    expect(contextCells[1]!.textContent).toContain("line1");
    await act(async () => {});
  });
});
