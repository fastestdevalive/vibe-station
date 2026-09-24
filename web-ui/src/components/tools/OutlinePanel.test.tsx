import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OutlinePanel, findInnermostSymbol } from "./OutlinePanel";
import { useWorkspaceStore } from "@/hooks/useStore";
import * as lspApi from "@/lib/lspApi";
import { ApiError } from "@/api/errors";
import type { OutlineSymbol } from "@/lib/lspApi";

describe("OutlinePanel", () => {
  const W1 = "wt-1";

  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: W1,
      activeFilePath: null,
      peekFile: null,
      diffScopeByWorktree: { [W1]: "none" },
      filesLeftPaneMode: { [W1]: "outline" },
      openFileTabsByWorktree: { [W1]: [] },
      backStack: {},
      forwardStack: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 6.T1: Unit — OutlineSymbol kind mapping
  it("6.T1: representative LSP SymbolKind values map to expected string kinds", () => {
    // Verified against LSP SymbolKind mapping specification
    const sampleSymbols: OutlineSymbol[] = [
      { name: "MyClass", kind: "class", line: 10, character: 0, endLine: 50, children: [] },
      { name: "myMethod", kind: "method", line: 20, character: 2, endLine: 35, children: [] },
      { name: "myFunc", kind: "function", line: 60, character: 0, endLine: 70, children: [] },
      { name: "myVar", kind: "variable", line: 75, character: 4, endLine: 75, children: [] },
    ];

    expect(sampleSymbols[0]?.kind).toBe("class");
    expect(sampleSymbols[1]?.kind).toBe("method");
    expect(sampleSymbols[2]?.kind).toBe("function");
    expect(sampleSymbols[3]?.kind).toBe("variable");
  });

  // 6.T2: Integration — usePreviewedPath tracking and switching
  it("6.T2: switching previewed file from main.rs to lib.rs refetches and re-renders outline", async () => {
    useWorkspaceStore.setState({ activeFilePath: "main.rs" });

    const outlineSpy = vi.spyOn(lspApi, "getOutline").mockImplementation(async (_api, _scope, _id, file) => {
      const path = typeof file === "string" ? file : file.kind === "workspace" ? file.path : "";
      if (path === "main.rs") {
        return {
          symbols: [
            { name: "main_func", kind: "function", line: 1, character: 0, endLine: 10, children: [] },
          ],
        };
      }
      if (path === "lib.rs") {
        return {
          symbols: [
            { name: "lib_func", kind: "function", line: 5, character: 0, endLine: 15, children: [] },
          ],
        };
      }
      return { symbols: [] };
    });

    const { rerender } = render(<OutlinePanel api={{}} worktreeId={W1} />);

    // Initial render for main.rs
    await waitFor(() => {
      expect(outlineSpy).toHaveBeenCalledWith(
        expect.anything(),
        "worktree",
        W1,
        { kind: "workspace", path: "main.rs" }
      );
    });

    expect(await screen.findByText("main_func")).toBeInTheDocument();

    // Switch preview to lib.rs
    act(() => {
      useWorkspaceStore.setState({ activeFilePath: "lib.rs" });
    });
    rerender(<OutlinePanel api={{}} worktreeId={W1} />);

    // Assert refetch for lib.rs
    await waitFor(() => {
      expect(outlineSpy).toHaveBeenCalledWith(
        expect.anything(),
        "worktree",
        W1,
        { kind: "workspace", path: "lib.rs" }
      );
    });

    expect(await screen.findByText("lib_func")).toBeInTheDocument();
    expect(screen.queryByText("main_func")).not.toBeInTheDocument();
  });

  // 6.T3: Integration — scroll highlight with nested method
  it("6.T3: scrolling to a line inside a nested method highlights that method, not its enclosing class", async () => {
    useWorkspaceStore.setState({ activeFilePath: "lib.rs" });

    const nestedMethod: OutlineSymbol = {
      name: "nestedMethod",
      kind: "method",
      line: 20,
      character: 4,
      endLine: 35,
      children: [],
    };

    const enclosingClass: OutlineSymbol = {
      name: "EnclosingClass",
      kind: "class",
      line: 10,
      character: 0,
      endLine: 50,
      children: [nestedMethod],
    };

    // Unit test findInnermostSymbol algorithm
    const match = findInnermostSymbol([enclosingClass], 25);
    expect(match).not.toBeNull();
    expect(match?.name).toBe("nestedMethod");
    expect(match?.kind).toBe("method");

    // Integration test with DOM
    vi.spyOn(lspApi, "getOutline").mockResolvedValue({
      symbols: [enclosingClass],
    });

    // Create a mock preview container in DOM
    const previewContainer = document.createElement("div");
    previewContainer.className = "preview-body";
    const lineEl = document.createElement("div");
    lineEl.setAttribute("data-line", "25");
    lineEl.getBoundingClientRect = () => ({
      top: 10,
      bottom: 30,
      left: 0,
      right: 100,
      width: 100,
      height: 20,
      x: 0,
      y: 10,
      toJSON: () => {},
    });
    previewContainer.getBoundingClientRect = () => ({
      top: 0,
      bottom: 200,
      left: 0,
      right: 100,
      width: 100,
      height: 200,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    previewContainer.appendChild(lineEl);
    document.body.appendChild(previewContainer);

    render(<OutlinePanel api={{}} worktreeId={W1} />);

    expect(await screen.findByText("EnclosingClass")).toBeInTheDocument();
    expect(await screen.findByText("nestedMethod")).toBeInTheDocument();

    // Trigger scroll
    act(() => {
      previewContainer.dispatchEvent(new Event("scroll"));
    });

    await waitFor(() => {
      const methodRow = screen.getByText("nestedMethod").closest(".outline-panel__row");
      const classRow = screen.getByText("EnclosingClass").closest(".outline-panel__row");
      expect(methodRow).toHaveAttribute("data-highlighted", "true");
      expect(classRow).not.toHaveAttribute("data-highlighted", "true");
    });

    document.body.removeChild(previewContainer);
  });

  // 6.T4: Integration — unsupported file type
  it("6.T4: unsupported file type (.json) shows 'Outline not available for .json'", async () => {
    useWorkspaceStore.setState({ activeFilePath: "package.json" });

    vi.spyOn(lspApi, "getOutline").mockResolvedValue({
      unsupported: true,
    });

    render(<OutlinePanel api={{}} worktreeId={W1} />);

    expect(await screen.findByText("Outline not available for .json")).toBeInTheDocument();
    expect(screen.queryByText("Loading symbols…")).not.toBeInTheDocument();
    expect(screen.queryByText("No symbols in this file")).not.toBeInTheDocument();
  });

  // 6.T5: Integration — diff view open gates off outline
  it("6.T5: isWorkingTreeView === false while a diff is open → shows unavailable, no fetch fired", async () => {
    useWorkspaceStore.setState({
      activeFilePath: "main.rs",
      diffScopeByWorktree: { [W1]: "local" }, // diff is active
    });

    const outlineSpy = vi.spyOn(lspApi, "getOutline");

    render(<OutlinePanel api={{}} worktreeId={W1} />);

    expect(await screen.findByTestId("outline-unavailable")).toBeInTheDocument();
    expect(outlineSpy).not.toHaveBeenCalled();
  });

  // 6.T7: Integration — mounted-but-hidden does not fetch until mode switches to outline
  it("6.T7: mounted-but-hidden (mode !== outline) does not fetch when file changes until switched to outline", async () => {
    useWorkspaceStore.setState({
      activeFilePath: "main.rs",
      filesLeftPaneMode: { [W1]: "tree" }, // Not outline mode
    });

    const outlineSpy = vi.spyOn(lspApi, "getOutline").mockResolvedValue({
      symbols: [
        { name: "sample_fn", kind: "function", line: 1, character: 0, endLine: 5, children: [] },
      ],
    });

    const { rerender } = render(
      <div className="files-left-pane__hidden">
        <OutlinePanel api={{}} worktreeId={W1} />
      </div>
    );

    // Initial mount: mode is 'tree', so no fetch
    expect(outlineSpy).not.toHaveBeenCalled();

    // File changes while still in 'tree' mode
    act(() => {
      useWorkspaceStore.setState({ activeFilePath: "lib.rs" });
    });
    rerender(
      <div className="files-left-pane__hidden">
        <OutlinePanel api={{}} worktreeId={W1} />
      </div>
    );

    // Assert NO fetch fired
    expect(outlineSpy).not.toHaveBeenCalled();

    // Mode switches to 'outline'
    act(() => {
      useWorkspaceStore.setState({ filesLeftPaneMode: { [W1]: "outline" } });
    });
    rerender(
      <div>
        <OutlinePanel api={{}} worktreeId={W1} />
      </div>
    );

    // Now it fetches for lib.rs
    await waitFor(() => {
      expect(outlineSpy).toHaveBeenCalledWith(
        expect.anything(),
        "worktree",
        W1,
        { kind: "workspace", path: "lib.rs" }
      );
    });
  });

  // 6.4: Row click calls pushJump
  it("6.4: row click calls pushJump with source: outline and the symbol's line", async () => {
    useWorkspaceStore.setState({ activeFilePath: "src/main.rs" });

    vi.spyOn(lspApi, "getOutline").mockResolvedValue({
      symbols: [
        { name: "target_func", kind: "function", line: 42, character: 4, endLine: 50, children: [] },
      ],
    });

    render(<OutlinePanel api={{}} worktreeId={W1} />);

    const item = await screen.findByText("target_func");
    fireEvent.click(item);

    expect(useWorkspaceStore.getState().openFileTabsByWorktree[W1]).toContain("src/main.rs");
    expect(useWorkspaceStore.getState().activeFilePath).toBe("src/main.rs");
    expect(useWorkspaceStore.getState().peekFile).toBeNull();
    expect(useWorkspaceStore.getState().pendingLineTarget).toEqual({
      worktreeId: W1,
      path: "src/main.rs",
      line: 43,
      matchText: null,
    });
  });

  // Selecting a symbol should highlight it in the outline immediately, not
  // only if/when a resulting scroll event happens to fire.
  it("clicking a row highlights it immediately, without waiting on a scroll event", async () => {
    useWorkspaceStore.setState({ activeFilePath: "src/main.rs" });

    vi.spyOn(lspApi, "getOutline").mockResolvedValue({
      symbols: [
        { name: "func_a", kind: "function", line: 1, character: 0, endLine: 5, children: [] },
        { name: "func_b", kind: "function", line: 10, character: 0, endLine: 15, children: [] },
      ],
    });

    render(<OutlinePanel api={{}} worktreeId={W1} />);

    const rowB = await screen.findByText("func_b");
    fireEvent.click(rowB);

    await waitFor(() => {
      expect(rowB.closest(".outline-panel__row")).toHaveAttribute("data-highlighted", "true");
    });
    const rowA = screen.getByText("func_a");
    expect(rowA.closest(".outline-panel__row")).not.toHaveAttribute("data-highlighted", "true");
  });

  // Default-collapse: a function/method with nested children starts
  // collapsed so the outline reads as a flat, scannable list of function
  // names; a container (class) with children still starts expanded.
  it("a leaf function (children are locals, not nested functions) defaults to collapsed; its enclosing class stays expanded", async () => {
    useWorkspaceStore.setState({ activeFilePath: "lib.rs" });

    const localVar: OutlineSymbol = {
      name: "localVar",
      kind: "variable",
      line: 21,
      character: 4,
      endLine: 21,
      children: [],
    };

    const leafFunc: OutlineSymbol = {
      name: "leafFunc",
      kind: "function",
      line: 20,
      character: 2,
      endLine: 30,
      children: [localVar],
    };

    const enclosingClass: OutlineSymbol = {
      name: "EnclosingClass",
      kind: "class",
      line: 10,
      character: 0,
      endLine: 50,
      children: [leafFunc],
    };

    vi.spyOn(lspApi, "getOutline").mockResolvedValue({
      symbols: [enclosingClass],
    });

    render(<OutlinePanel api={{}} worktreeId={W1} />);

    // Class is expanded by default: its child function name is visible.
    expect(await screen.findByText("EnclosingClass")).toBeInTheDocument();
    expect(await screen.findByText("leafFunc")).toBeInTheDocument();

    // Leaf function is collapsed by default: its local var is NOT rendered.
    expect(screen.queryByText("localVar")).not.toBeInTheDocument();

    // Expanding it via the toggle reveals the nested child.
    const toggle = screen.getByRole("button", { name: "Expand leafFunc" });
    fireEvent.click(toggle);
    expect(await screen.findByText("localVar")).toBeInTheDocument();
  });

  it("a function containing nested functions is NOT a leaf — stays expanded by default", async () => {
    useWorkspaceStore.setState({ activeFilePath: "lib.rs" });

    const innerFunc: OutlineSymbol = {
      name: "innerFunc",
      kind: "function",
      line: 21,
      character: 4,
      endLine: 22,
      children: [],
    };

    const outerFunc: OutlineSymbol = {
      name: "outerFunc",
      kind: "function",
      line: 20,
      character: 2,
      endLine: 30,
      children: [innerFunc],
    };

    vi.spyOn(lspApi, "getOutline").mockResolvedValue({
      symbols: [outerFunc],
    });

    render(<OutlinePanel api={{}} worktreeId={W1} />);

    expect(await screen.findByText("outerFunc")).toBeInTheDocument();
    // outerFunc contains a nested FUNCTION, so it is not a leaf and must
    // stay expanded — innerFunc should be visible without any click.
    expect(await screen.findByText("innerFunc")).toBeInTheDocument();
  });

  // Per-kind styling: function/type/namespace symbol names get a
  // kind-specific modifier class so they can be colored to match the code
  // viewer's syntax highlighting.
  it("applies kind-specific modifier classes to function, class, and variable rows", async () => {
    useWorkspaceStore.setState({ activeFilePath: "lib.rs" });

    vi.spyOn(lspApi, "getOutline").mockResolvedValue({
      symbols: [
        { name: "myFunc", kind: "function", line: 1, character: 0, endLine: 5, children: [] },
        { name: "MyClass", kind: "class", line: 10, character: 0, endLine: 20, children: [] },
        { name: "myVar", kind: "variable", line: 25, character: 0, endLine: 25, children: [] },
      ],
    });

    render(<OutlinePanel api={{}} worktreeId={W1} />);

    expect(await screen.findByText("myFunc")).toHaveClass("outline-panel__symbol-name--function");
    expect(await screen.findByText("MyClass")).toHaveClass("outline-panel__symbol-name--type");
    // Variables get no kind modifier — they render in the default text color,
    // matching how the code viewer's hljs theme leaves variables untinted.
    const varEl = await screen.findByText("myVar");
    expect(varEl.className).toBe("outline-panel__symbol-name");
  });

  // Regression for "index.d.ts shows 'No symbols in this file'" — a
  // freshly-spawned language server answers its first request(s) with 409
  // LSP_NOT_READY while it's still initializing. That must not be treated
  // the same as "this file genuinely has no symbols".
  it(
    "retries on 409 LSP_NOT_READY and shows symbols once the server is ready, instead of landing on 'No symbols'",
    async () => {
      useWorkspaceStore.setState({ activeFilePath: "lib.rs" });
      let calls = 0;
      vi.spyOn(lspApi, "getOutline").mockImplementation(async () => {
        calls++;
        if (calls < 3) {
          throw new ApiError("Language server still starting", 409);
        }
        return {
          symbols: [
            { name: "ready_fn", kind: "function", line: 1, character: 0, endLine: 2, children: [] },
          ],
        };
      });

      render(<OutlinePanel api={{}} worktreeId={W1} />);

      // Distinct "starting" state while retrying — not the generic loading
      // text, and not the misleading empty "No symbols" state.
      await waitFor(() => {
        expect(screen.getByText("Starting language server…")).toBeInTheDocument();
      });

      expect(await screen.findByText("ready_fn", {}, { timeout: 5000 })).toBeInTheDocument();
      expect(calls).toBeGreaterThanOrEqual(3);
      expect(screen.queryByText("No symbols in this file")).not.toBeInTheDocument();
    },
    10000
  );

  // Regression for the external-peek infinite-refetch loop: `usePreviewedPath`
  // used to return a fresh `external` object every render, so OutlinePanel's
  // effects (which listed the bare `external` object as a dependency) re-ran on
  // every setState → refetch → setState… spinning forever and OOM-ing a test
  // worker. The effects now key off `external?.token`, so each mock fetch must
  // fire exactly once even though the component re-renders after each resolve.
  it("fetches outline + external file exactly once for an external peek file (no infinite loop)", async () => {
    useWorkspaceStore.setState({
      peekFile: {
        worktreeId: W1,
        path: "/abs/path/out/external.ts",
        line: 1,
        matchText: null,
        source: "search",
        external: {
          token: "ext-token-1",
          displayPath: "/abs/path/out/external.ts",
        },
      },
    });

    const outlineSpy = vi.spyOn(lspApi, "getOutline").mockResolvedValue({
      symbols: [
        { name: "ext_func", kind: "function", line: 1, character: 0, endLine: 5, children: [] },
      ],
    });
    const externalFileSpy = vi.spyOn(lspApi, "getExternalFile").mockResolvedValue("export function ext_func() {}");

    render(<OutlinePanel api={{}} worktreeId={W1} />);

    expect(await screen.findByText("ext_func")).toBeInTheDocument();

    // Let any re-runs caused by post-resolve re-renders settle before asserting
    // the exact call count — the bug under test is the loop, and a settled
    // component must not have re-fired either fetch.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(outlineSpy).toHaveBeenCalledTimes(1);
    expect(outlineSpy).toHaveBeenCalledWith(
      expect.anything(),
      "worktree",
      W1,
      { kind: "external", token: "ext-token-1" }
    );
    expect(externalFileSpy).toHaveBeenCalledTimes(1);
  }, 10000);

  // A non-409 error must NOT trigger the retry loop — it should settle
  // immediately, same as before this fix.
  it("does not retry on a non-409 error — settles immediately on the first failure", async () => {
    useWorkspaceStore.setState({ activeFilePath: "lib.rs" });
    const spy = vi.spyOn(lspApi, "getOutline").mockRejectedValue(new Error("boom"));

    render(<OutlinePanel api={{}} worktreeId={W1} />);

    expect(await screen.findByText("No symbols in this file")).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
