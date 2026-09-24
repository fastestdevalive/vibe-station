import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CodeView } from "./CodeView";
import { useWorkspaceStore } from "@/hooks/useStore";
import * as lspApi from "@/lib/lspApi";
import { ApiError } from "@/api/errors";

describe("CodeView", () => {
  it("5.T1: renders line with added modifier class when gutterMarks contains that line", () => {
    const code = "line 1\nline 2 added\nline 3";
    const gutterMarks = new Map<number, "added" | "modified" | "deleted">([
      [2, "added"],
    ]);
    const { container } = render(
      <CodeView
        code={code}
        gutterMarks={gutterMarks}
        filePath="test.txt"
      />
    );

    const lines = container.querySelectorAll(".workspace-code-line");
    expect(lines.length).toBe(3);
    expect(lines[1]!.className).toContain("workspace-code-line--added");
  });

  it("5.T2: line with no gutterMarks entry renders without modifier class", () => {
    const code = "line 1\nline 2\nline 3";
    const gutterMarks = new Map<number, "added" | "modified" | "deleted">([
      [2, "added"],
    ]);
    const { container } = render(
      <CodeView
        code={code}
        gutterMarks={gutterMarks}
        filePath="test.txt"
      />
    );

    const lines = container.querySelectorAll(".workspace-code-line");
    expect(lines[0]!.className).not.toContain("workspace-code-line--");
    expect(lines[2]!.className).not.toContain("workspace-code-line--");
  });

  it("5.T2: noGutter={true} suppresses modifier classes even when gutterMarks has entries", () => {
    const code = "line 1\nline 2\nline 3";
    const gutterMarks = new Map<number, "added" | "modified" | "deleted">([
      [1, "modified"],
      [2, "deleted"],
    ]);
    const { container } = render(
      <CodeView
        code={code}
        gutterMarks={gutterMarks}
        noGutter={true}
        filePath="test.txt"
      />
    );

    const lines = container.querySelectorAll(".workspace-code-line");
    expect(lines[0]!.className).not.toContain("workspace-code-line--");
    expect(lines[1]!.className).not.toContain("workspace-code-line--");
    const gutters = container.querySelectorAll(".workspace-code-gutter");
    expect(gutters.length).toBe(0);
  });

  it("renders modified marker on the correct line", () => {
    const code = "line 1\nline 2\nline 3 modified";
    const gutterMarks = new Map<number, "added" | "modified" | "deleted">([
      [3, "modified"],
    ]);
    const { container } = render(
      <CodeView
        code={code}
        gutterMarks={gutterMarks}
        filePath="test.txt"
      />
    );

    const lines = container.querySelectorAll(".workspace-code-line");
    expect(lines[2]!.className).toContain("workspace-code-line--modified");
  });

  it("renders deleted marker on the correct line", () => {
    const code = "line 1 deleted\nline 2\nline 3";
    const gutterMarks = new Map<number, "added" | "modified" | "deleted">([
      [1, "deleted"],
    ]);
    const { container } = render(
      <CodeView
        code={code}
        gutterMarks={gutterMarks}
        filePath="test.txt"
      />
    );

    const lines = container.querySelectorAll(".workspace-code-line");
    expect(lines[0]!.className).toContain("workspace-code-line--deleted");
  });

  it("highlightLine adds the target modifier class to the matching line only", () => {
    const code = "line 1\nline 2\nline 3";
    const { container } = render(<CodeView code={code} filePath="test.txt" highlightLine={2} />);

    const lines = container.querySelectorAll(".workspace-code-line");
    expect(lines[0]!.className).not.toContain("workspace-code-line--target");
    expect(lines[1]!.className).toContain("workspace-code-line--target");
    expect(lines[2]!.className).not.toContain("workspace-code-line--target");
  });

  it("highlightMatchText marks the matched substring within the target line", () => {
    const code = "const x = 1;\nconst hello = 2;\nconst z = 3;";
    const { container } = render(
      <CodeView code={code} filePath="test.txt" highlightLine={2} highlightMatchText="hello" />,
    );

    const lines = container.querySelectorAll(".workspace-code-line");
    const mark = lines[1]!.querySelector("mark.workspace-code-match");
    expect(mark).toBeTruthy();
    expect(mark?.textContent).toBe("hello");
    expect(lines[1]!.querySelector(".workspace-code-content")?.textContent).toBe("const hello = 2;");
  });

  it("no mark rendered when highlightMatchText isn't found on the target line", () => {
    const code = "const x = 1;\nconst y = 2;";
    const { container } = render(
      <CodeView code={code} filePath="test.txt" highlightLine={2} highlightMatchText="nope" />,
    );

    expect(container.querySelector("mark.workspace-code-match")).toBeNull();
    const lines = container.querySelectorAll(".workspace-code-line");
    expect(lines[1]!.className).toContain("workspace-code-line--target");
  });

  it("preserves Shiki syntax-highlighting spans around the mark, for a match that spans a single token", async () => {
    const code = "const hello = 2;\nconst world = 3;";
    const { container } = render(
      <CodeView code={code} filePath="test.ts" highlightLine={1} highlightMatchText="hello" />,
    );

    await waitFor(() => {
      expect(container.querySelector(".workspace-code-content--shiki")).toBeTruthy();
    });
    await waitFor(() => {
      expect(container.querySelector("mark.workspace-code-match")).toBeTruthy();
    });

    const targetContent = container.querySelectorAll(".workspace-code-line")[0]!.querySelector(".workspace-code-content");
    expect(targetContent).toHaveClass("workspace-code-content--shiki");
    expect(container.querySelector('.workspace-code-content--shiki [style*="color"]')).toBeTruthy();
    const mark = container.querySelector("mark.workspace-code-match");
    expect(mark?.textContent).toBe("hello");
  });

  it("preserves Shiki syntax-highlighting when a match spans multiple tokens", async () => {
    const code = "const helloWorld = x + y;";
    const { container } = render(
      <CodeView code={code} filePath="test.ts" highlightLine={1} highlightMatchText="x + y" />,
    );

    await waitFor(() => {
      expect(container.querySelector(".workspace-code-content--shiki")).toBeTruthy();
    });
    await waitFor(() => {
      expect(container.querySelector("mark.workspace-code-match")).toBeTruthy();
    });

    const marks = container.querySelectorAll("mark.workspace-code-match");
    expect(marks.length).toBeGreaterThan(1);
    expect(Array.from(marks).map((m) => m.textContent).join("")).toBe("x + y");
    expect(container.querySelector(".workspace-code-content--shiki")).toHaveClass("workspace-code-content--shiki");
  });

  // ── Phase 3: Go-to-Definition Tests ──────────────────────────────────────────

  describe("Phase 3 — Go-to-Definition", () => {
    const W1 = "wt-1";

    beforeEach(() => {
      useWorkspaceStore.setState({
        activeWorktreeId: W1,
        activeFilePath: "/main.ts",
        openFileTabsByWorktree: { [W1]: ["/main.ts"] },
        activeFileTabIdxByWorktree: { [W1]: 0 },
        peekFile: null,
        backStack: {},
        forwardStack: {},
        // Reset so a find-references trigger in one test can't leak into
        // the next (filesLeftPaneMode/pendingReferencesQuery aren't among
        // the fields this suite otherwise resets per test).
        pendingLineTarget: null,
        pendingReferencesQuery: null,
        filesLeftPaneMode: {},
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // 3.1: Armed cursor state on pointer enter + modifier
    it("3.1: sets data-lsp-armed='true' when Ctrl/Cmd is down over the code container", () => {
      const code = "const x = 1;\nconst y = 2;";
      const { container } = render(
        <CodeView
          code={code}
          filePath="/main.ts"
          api={{}}
          worktreeId={W1}
          lspFileRef={{ kind: "workspace", path: "/main.ts" }}
        />
      );

      const pre = container.querySelector("pre.workspace-code-viewer")!;
      expect(pre.getAttribute("data-lsp-armed")).toBeNull();

      // Pointer enters without Ctrl
      fireEvent.pointerEnter(pre);
      expect(pre.getAttribute("data-lsp-armed")).toBeNull();

      // Keydown Ctrl while pointer is inside
      fireEvent.keyDown(window, { key: "Control", ctrlKey: true });
      expect(pre.getAttribute("data-lsp-armed")).toBe("true");

      // Keyup Ctrl removes armed state
      fireEvent.keyUp(window, { key: "Control", ctrlKey: false });
      expect(pre.getAttribute("data-lsp-armed")).toBeNull();

      // Pointer leaves disarms
      fireEvent.pointerEnter(pre, { ctrlKey: true });
      expect(pre.getAttribute("data-lsp-armed")).toBe("true");
      fireEvent.pointerLeave(pre);
      expect(pre.getAttribute("data-lsp-armed")).toBeNull();
    });

    // 3.T1 Unit — click-vs-drag guard
    it("3.T1: a mousedown→(move >5px)→mouseup sequence does not trigger navigation; same-point does", async () => {
      const code = "const x = 1;\nconst y = 2;";
      const spy = vi.spyOn(lspApi, "getDefinition").mockResolvedValue({
        locations: [
          { external: false, path: "/target.ts", line: 10, character: 0, preview: "fn target()", confidence: "lsp" },
        ],
      });

      const { container } = render(
        <CodeView
          code={code}
          filePath="/main.ts"
          api={{}}
          worktreeId={W1}
          lspFileRef={{ kind: "workspace", path: "/main.ts" }}
        />
      );

      const content = container.querySelector(".workspace-code-content")!;

      // 1. Move >5px (10, 10) -> (20, 20) -> should NOT trigger
      fireEvent.mouseDown(content, { clientX: 10, clientY: 10, ctrlKey: true });
      fireEvent.mouseMove(content, { clientX: 20, clientY: 20, buttons: 1, ctrlKey: true });
      fireEvent.mouseUp(content, { clientX: 20, clientY: 20, ctrlKey: true });
      fireEvent.click(content, { clientX: 20, clientY: 20, ctrlKey: true });

      expect(spy).not.toHaveBeenCalled();
      expect(useWorkspaceStore.getState().peekFile).toBeNull();
      expect(useWorkspaceStore.getState().activeFilePath).toBe("/main.ts");
      expect(useWorkspaceStore.getState().openFileTabsByWorktree[W1]).toEqual(["/main.ts"]);

      // 2. Same point (10, 10) -> (10, 10) with ctrlKey -> SHOULD trigger
      fireEvent.mouseDown(content, { clientX: 10, clientY: 10, ctrlKey: true });
      fireEvent.mouseUp(content, { clientX: 10, clientY: 10, ctrlKey: true });
      fireEvent.click(content, { clientX: 10, clientY: 10, ctrlKey: true });

      await waitFor(() => {
        expect(spy).toHaveBeenCalled();
      });
      expect(useWorkspaceStore.getState().openFileTabsByWorktree[W1]).toContain("/target.ts");
      expect(useWorkspaceStore.getState().activeFilePath).toBe("/target.ts");
      expect(useWorkspaceStore.getState().activeFileTabIdxByWorktree[W1]).toBe(1);
      expect(useWorkspaceStore.getState().peekFile).toBeNull();
    });

    // 3.T2 Integration — single in-workspace match
    it("3.T2: single in-workspace match opens permanent tab matching mocked response; recoverable via navigateBack", async () => {
      // Seed a prior peek from search
      useWorkspaceStore.setState({
        peekFile: {
          worktreeId: W1,
          path: "/search-result.ts",
          line: 5,
          matchText: "match",
          source: "search",
        },
      });

      const spy = vi.spyOn(lspApi, "getDefinition").mockResolvedValue({
        locations: [
          { external: false, path: "/def-target.ts", line: 42, character: 4, preview: "fn target()", confidence: "lsp" },
        ],
      });

      const code = "const x = 1;\nconst y = 2;";
      const { container } = render(
        <CodeView
          code={code}
          filePath="/main.ts"
          api={{}}
          worktreeId={W1}
          lspFileRef={{ kind: "workspace", path: "/main.ts" }}
        />
      );

      const content = container.querySelector(".workspace-code-content")!;
      fireEvent.mouseDown(content, { clientX: 50, clientY: 50, ctrlKey: true });
      fireEvent.mouseUp(content, { clientX: 50, clientY: 50, ctrlKey: true });
      fireEvent.click(content, { clientX: 50, clientY: 50, ctrlKey: true });

      await waitFor(() => {
        expect(spy).toHaveBeenCalled();
      });

      // Decision 19: in-workspace definition match commits to a permanent tab
      expect(useWorkspaceStore.getState().openFileTabsByWorktree[W1]).toContain("/def-target.ts");
      expect(useWorkspaceStore.getState().activeFilePath).toBe("/def-target.ts");
      expect(useWorkspaceStore.getState().activeFileTabIdxByWorktree[W1]).toBe(1);
      expect(useWorkspaceStore.getState().peekFile).toBeNull();

      // Prior peek recoverable via navigateBack
      useWorkspaceStore.getState().navigateBack(W1);
      expect(useWorkspaceStore.getState().peekFile?.path).toBe("/search-result.ts");
      expect(useWorkspaceStore.getState().peekFile?.source).toBe("search");
    });

    // 3.T3 Integration — single external match
    it("3.T3: single external match shows message; peekFile and openFileTabsByWorktree unchanged", async () => {
      const spy = vi.spyOn(lspApi, "getDefinition").mockResolvedValue({
        locations: [
          {
            external: true,
            path: null,
            token: null,
            displayPath: "std::sync::Arc",
            line: 10,
            character: 4,
            preview: "pub struct Arc<T>",
            confidence: "lsp",
          },
        ],
      });

      const code = "const x = 1;\nconst y = 2;";
      const { container } = render(
        <CodeView
          code={code}
          filePath="/main.ts"
          api={{}}
          worktreeId={W1}
          lspFileRef={{ kind: "workspace", path: "/main.ts" }}
        />
      );

      const content = container.querySelector(".workspace-code-content")!;
      fireEvent.mouseDown(content, { clientX: 50, clientY: 50, ctrlKey: true });
      fireEvent.mouseUp(content, { clientX: 50, clientY: 50, ctrlKey: true });
      fireEvent.click(content, { clientX: 50, clientY: 50, ctrlKey: true });

      await waitFor(() => {
        expect(spy).toHaveBeenCalled();
      });

      // Shows 3.6's message at click point
      expect(
        await screen.findByText(
          "Definition is outside this workspace — external file viewing not yet available",
        ),
      ).toBeInTheDocument();

      // peekFile and tabs unchanged
      expect(useWorkspaceStore.getState().peekFile).toBeNull();
      expect(useWorkspaceStore.getState().openFileTabsByWorktree[W1]).toEqual(["/main.ts"]);
    });

    // 3.T4 Integration — multi-match picker
    it("3.T4: mocked 3-location response renders picker; Enter on external shows message; Enter on workspace navigates", async () => {
      const locations: lspApi.Location[] = [
        { external: false, path: "/src/alpha.ts", line: 10, character: 0, preview: "fn alpha()", confidence: "lsp" },
        { external: true, path: null, token: null, displayPath: "std::core", line: 5, character: 0, preview: "fn core()", confidence: "lsp" },
        { external: false, path: "/src/beta.ts", line: 20, character: 0, preview: "fn beta()", confidence: "lsp" },
      ];

      vi.spyOn(lspApi, "getDefinition").mockResolvedValue({ locations });

      const code = "const x = 1;\nconst y = 2;";
      const { container } = render(
        <CodeView
          code={code}
          filePath="/main.ts"
          api={{}}
          worktreeId={W1}
          lspFileRef={{ kind: "workspace", path: "/main.ts" }}
        />
      );

      const content = container.querySelector(".workspace-code-content")!;
      fireEvent.mouseDown(content, { clientX: 50, clientY: 50, ctrlKey: true });
      fireEvent.mouseUp(content, { clientX: 50, clientY: 50, ctrlKey: true });
      fireEvent.click(content, { clientX: 50, clientY: 50, ctrlKey: true });

      // Renders picker
      expect(await screen.findByRole("dialog", { name: "Go to definition" })).toBeInTheDocument();
      expect(screen.getByText("/src/alpha.ts:11")).toBeInTheDocument();
      expect(screen.getByText("std::core:6")).toBeInTheDocument();
      expect(screen.getByText("/src/beta.ts:21")).toBeInTheDocument();

      // Arrow down to external row (idx 1)
      fireEvent.keyDown(window, { key: "ArrowDown" });
      const options = screen.getAllByRole("option");
      expect(options[1]).toHaveAttribute("aria-selected", "true");

      // Enter on external row
      fireEvent.keyDown(window, { key: "Enter" });

      // Shows external message, does not navigate
      expect(
        await screen.findByText(
          "Definition is outside this workspace — external file viewing not yet available",
        ),
      ).toBeInTheDocument();
      expect(useWorkspaceStore.getState().peekFile).toBeNull();
      expect(useWorkspaceStore.getState().activeFilePath).toBe("/main.ts");
      expect(useWorkspaceStore.getState().openFileTabsByWorktree[W1]).toEqual(["/main.ts"]);

      // Re-trigger click for workspace navigation
      const liveContent = container.querySelector(".workspace-code-content")!;
      fireEvent.mouseDown(liveContent, { clientX: 50, clientY: 50, ctrlKey: true });
      fireEvent.mouseUp(liveContent, { clientX: 50, clientY: 50, ctrlKey: true });
      fireEvent.click(liveContent, { clientX: 50, clientY: 50, ctrlKey: true });

      expect(await screen.findByRole("dialog", { name: "Go to definition" })).toBeInTheDocument();
      // First row (/src/alpha.ts) is selected by default -> hit Enter
      fireEvent.keyDown(window, { key: "Enter" });

      expect(useWorkspaceStore.getState().openFileTabsByWorktree[W1]).toContain("/src/alpha.ts");
      expect(useWorkspaceStore.getState().activeFilePath).toBe("/src/alpha.ts");
      expect(useWorkspaceStore.getState().activeFileTabIdxByWorktree[W1]).toBe(1);
      expect(useWorkspaceStore.getState().peekFile).toBeNull();
    });

    it("renders (text match) badge when location confidence is text", async () => {
      const locations: lspApi.Location[] = [
        { external: false, path: "/src/alpha.ts", line: 10, character: 0, preview: "fn alpha()", confidence: "text" },
        { external: false, path: "/src/beta.ts", line: 20, character: 0, preview: "fn beta()", confidence: "lsp" },
      ];

      vi.spyOn(lspApi, "getDefinition").mockResolvedValue({ locations });

      const code = "const x = 1;\nconst y = 2;";
      const { container } = render(
        <CodeView
          code={code}
          filePath="/main.ts"
          api={{}}
          worktreeId={W1}
          lspFileRef={{ kind: "workspace", path: "/main.ts" }}
        />
      );

      const content = container.querySelector(".workspace-code-content")!;
      fireEvent.mouseDown(content, { clientX: 50, clientY: 50, ctrlKey: true });
      fireEvent.mouseUp(content, { clientX: 50, clientY: 50, ctrlKey: true });
      fireEvent.click(content, { clientX: 50, clientY: 50, ctrlKey: true });

      expect(await screen.findByRole("dialog", { name: "Go to definition" })).toBeInTheDocument();
      expect(screen.getByText("(text match)")).toBeInTheDocument();
    });

    // 3.T5 Integration — stale-response discard
    it("3.T5: fire click, navigate elsewhere before response resolves; late response does not mutate peekFile", async () => {
      let resolveDef!: (res: lspApi.LspDefinitionResponse) => void;
      const pendingPromise = new Promise<lspApi.LspDefinitionResponse>((res) => {
        resolveDef = res;
      });
      vi.spyOn(lspApi, "getDefinition").mockReturnValue(pendingPromise);

      const code = "const x = 1;\nconst y = 2;";
      const { container, rerender } = render(
        <CodeView
          code={code}
          filePath="/main.ts"
          api={{}}
          worktreeId={W1}
          lspFileRef={{ kind: "workspace", path: "/main.ts" }}
        />
      );

      const content = container.querySelector(".workspace-code-content")!;
      fireEvent.mouseDown(content, { clientX: 50, clientY: 50, ctrlKey: true });
      fireEvent.mouseUp(content, { clientX: 50, clientY: 50, ctrlKey: true });
      fireEvent.click(content, { clientX: 50, clientY: 50, ctrlKey: true });

      // Navigate elsewhere before response resolves
      rerender(
        <CodeView
          code="different content"
          filePath="/other.ts"
          api={{}}
          worktreeId={W1}
          lspFileRef={{ kind: "workspace", path: "/other.ts" }}
        />
      );

      // Now late response resolves
      resolveDef({
        locations: [
          { external: false, path: "/late.ts", line: 99, character: 0, preview: "late", confidence: "lsp" },
        ],
      });

      await new Promise((r) => setTimeout(r, 20));

      // peekFile is not mutated
      expect(useWorkspaceStore.getState().peekFile).toBeNull();
      expect(useWorkspaceStore.getState().activeFilePath).toBe("/main.ts");
      expect(useWorkspaceStore.getState().openFileTabsByWorktree[W1]).toEqual(["/main.ts"]);
    });

    // 3.T6 Regression — plain click still performs native text selection
    it("3.T6: a plain non-modifier click does not prevent default or trigger definition lookup", () => {
      const spy = vi.spyOn(lspApi, "getDefinition");
      const code = "const x = 1;\nconst y = 2;";
      const { container } = render(
        <CodeView
          code={code}
          filePath="/main.ts"
          api={{}}
          worktreeId={W1}
          lspFileRef={{ kind: "workspace", path: "/main.ts" }}
        />
      );

      const content = container.querySelector(".workspace-code-content")!;
      const clickEvent = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: 50,
        clientY: 50,
        ctrlKey: false,
        metaKey: false,
      });

      content.dispatchEvent(clickEvent);

      expect(spy).not.toHaveBeenCalled();
      expect(clickEvent.defaultPrevented).toBe(false);
      expect(useWorkspaceStore.getState().peekFile).toBeNull();
      expect(useWorkspaceStore.getState().activeFilePath).toBe("/main.ts");
      expect(useWorkspaceStore.getState().openFileTabsByWorktree[W1]).toEqual(["/main.ts"]);
    });

    // 3.9: Keyboard shortcut Alt+G for selection
    it("3.9: Alt+G triggers go-to-def on the selection anchor inside code container", async () => {
      const spy = vi.spyOn(lspApi, "getDefinition").mockResolvedValue({
        locations: [
          { external: false, path: "/def.ts", line: 7, character: 0, preview: "def", confidence: "lsp" },
        ],
      });

      const code = "const x = 1;\nconst y = 2;";
      const { container } = render(
        <CodeView
          code={code}
          filePath="/main.ts"
          api={{}}
          worktreeId={W1}
          lspFileRef={{ kind: "workspace", path: "/main.ts" }}
        />
      );

      const content = container.querySelector(".workspace-code-content")!;
      const textNode = content.firstChild ?? content;

      // Mock native getSelection returning selection inside container
      const originalGetSelection = window.getSelection;
      window.getSelection = vi.fn().mockReturnValue({
        anchorNode: textNode,
        anchorOffset: 6,
        rangeCount: 1,
        getRangeAt: () => ({
          getBoundingClientRect: () => ({ left: 40, bottom: 50, width: 20, height: 10 }),
        }),
      });

      try {
        fireEvent.keyDown(window, { code: "KeyG", altKey: true });

        await waitFor(() => {
          expect(spy).toHaveBeenCalled();
        });

        expect(useWorkspaceStore.getState().openFileTabsByWorktree[W1]).toContain("/def.ts");
        expect(useWorkspaceStore.getState().activeFilePath).toBe("/def.ts");
        expect(useWorkspaceStore.getState().activeFileTabIdxByWorktree[W1]).toBe(1);
        expect(useWorkspaceStore.getState().peekFile).toBeNull();
      } finally {
        window.getSelection = originalGetSelection;
      }
    });

    // 3.3: 409 LSP_NOT_READY holds and retries once
    it("3.3: 409 LSP_NOT_READY retries once and navigates on success", async () => {
      const spy = vi.spyOn(lspApi, "getDefinition")
        .mockRejectedValueOnce(new ApiError("LSP_NOT_READY", 409))
        .mockResolvedValueOnce({
          locations: [
            { external: false, path: "/retry-success.ts", line: 12, character: 0, preview: "ok", confidence: "lsp" },
          ],
        });

      const code = "const x = 1;\nconst y = 2;";
      const { container } = render(
        <CodeView
          code={code}
          filePath="/main.ts"
          api={{}}
          worktreeId={W1}
          retryDelayMs={10}
          lspFileRef={{ kind: "workspace", path: "/main.ts" }}
        />
      );

      const content = container.querySelector(".workspace-code-content")!;
      fireEvent.mouseDown(content, { clientX: 50, clientY: 50, ctrlKey: true });
      fireEvent.mouseUp(content, { clientX: 50, clientY: 50, ctrlKey: true });
      fireEvent.click(content, { clientX: 50, clientY: 50, ctrlKey: true });

      await waitFor(() => {
        expect(spy).toHaveBeenCalledTimes(2);
      });

      expect(useWorkspaceStore.getState().openFileTabsByWorktree[W1]).toContain("/retry-success.ts");
      expect(useWorkspaceStore.getState().activeFilePath).toBe("/retry-success.ts");
      expect(useWorkspaceStore.getState().activeFileTabIdxByWorktree[W1]).toBe(1);
      expect(useWorkspaceStore.getState().peekFile).toBeNull();
    });

    // 3.3: 409 failing twice shows "still starting — click again"
    it("3.3: 409 failing twice shows 'still starting — click again'", async () => {
      vi.spyOn(lspApi, "getDefinition").mockRejectedValue(new ApiError("LSP_NOT_READY", 409));

      const code = "const x = 1;\nconst y = 2;";
      const { container } = render(
        <CodeView
          code={code}
          filePath="/main.ts"
          api={{}}
          worktreeId={W1}
          retryDelayMs={10}
          lspFileRef={{ kind: "workspace", path: "/main.ts" }}
        />
      );

      const content = container.querySelector(".workspace-code-content")!;
      fireEvent.mouseDown(content, { clientX: 50, clientY: 50, ctrlKey: true });
      fireEvent.mouseUp(content, { clientX: 50, clientY: 50, ctrlKey: true });
      fireEvent.click(content, { clientX: 50, clientY: 50, ctrlKey: true });

      expect(await screen.findByText("still starting — click again")).toBeInTheDocument();
      expect(useWorkspaceStore.getState().peekFile).toBeNull();
      expect(useWorkspaceStore.getState().activeFilePath).toBe("/main.ts");
      expect(useWorkspaceStore.getState().openFileTabsByWorktree[W1]).toEqual(["/main.ts"]);
    });

    // 3.8: Zero results -> silent no-op
    it("3.8: zero results (locations: []) is a silent no-op", async () => {
      const spy = vi.spyOn(lspApi, "getDefinition").mockResolvedValue({ locations: [] });

      const code = "const x = 1;\nconst y = 2;";
      const { container } = render(
        <CodeView
          code={code}
          filePath="/main.ts"
          api={{}}
          worktreeId={W1}
          lspFileRef={{ kind: "workspace", path: "/main.ts" }}
        />
      );

      const content = container.querySelector(".workspace-code-content")!;
      fireEvent.mouseDown(content, { clientX: 50, clientY: 50, ctrlKey: true });
      fireEvent.mouseUp(content, { clientX: 50, clientY: 50, ctrlKey: true });
      fireEvent.click(content, { clientX: 50, clientY: 50, ctrlKey: true });

      await waitFor(() => {
        expect(spy).toHaveBeenCalled();
      });

      expect(useWorkspaceStore.getState().peekFile).toBeNull();
      expect(useWorkspaceStore.getState().activeFilePath).toBe("/main.ts");
      expect(useWorkspaceStore.getState().openFileTabsByWorktree[W1]).toEqual(["/main.ts"]);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    // Follow-up: definition-vs-usage distinction. A cmd-click whose single
    // getDefinition result points back at the exact word that was clicked
    // means the click landed on the declaration itself — that must open
    // references, not "navigate" to where you already are.
    it("cmd-click on the definition itself opens references instead of self-navigating", async () => {
      const defSpy = vi.spyOn(lspApi, "getDefinition").mockResolvedValue({
        locations: [
          { external: false, path: "/main.ts", line: 0, character: 0, preview: "myFunc();", confidence: "lsp" },
        ],
      });

      const code = "myFunc();\nconst y = 2;";
      const { container } = render(
        <CodeView
          code={code}
          filePath="/main.ts"
          api={{}}
          worktreeId={W1}
          lspFileRef={{ kind: "workspace", path: "/main.ts" }}
        />
      );

      const content = container.querySelector(".workspace-code-content")!;
      fireEvent.mouseDown(content, { clientX: 10, clientY: 10, ctrlKey: true });
      fireEvent.mouseUp(content, { clientX: 10, clientY: 10, ctrlKey: true });
      fireEvent.click(content, { clientX: 10, clientY: 10, ctrlKey: true });

      await waitFor(() => {
        expect(defSpy).toHaveBeenCalled();
      });

      // No self-navigating jump — still the same file/tab, no new peek.
      expect(useWorkspaceStore.getState().activeFilePath).toBe("/main.ts");
      expect(useWorkspaceStore.getState().openFileTabsByWorktree[W1]).toEqual(["/main.ts"]);
      expect(useWorkspaceStore.getState().peekFile).toBeNull();

      // References view opened instead, for the clicked symbol.
      const store = useWorkspaceStore.getState();
      expect(store.filesLeftPaneMode[W1]).toBe("references");
      expect(store.pendingReferencesQuery).toEqual({
        worktreeId: W1,
        path: "/main.ts",
        line: 0,
        character: 0,
        symbol: "myFunc",
      });
    });

    // Same file, but the definition result points at a DIFFERENT word than
    // the one clicked — must still navigate normally, confirming the
    // self-click check doesn't over-trigger for an ordinary same-file jump.
    it("cmd-click on a usage still navigates when the definition is elsewhere in the same file", async () => {
      vi.spyOn(lspApi, "getDefinition").mockResolvedValue({
        locations: [
          { external: false, path: "/main.ts", line: 5, character: 9, preview: "function myFunc() {}", confidence: "lsp" },
        ],
      });

      const code = "myFunc();\nconst y = 2;";
      const { container } = render(
        <CodeView
          code={code}
          filePath="/main.ts"
          api={{}}
          worktreeId={W1}
          lspFileRef={{ kind: "workspace", path: "/main.ts" }}
        />
      );

      const content = container.querySelector(".workspace-code-content")!;
      fireEvent.mouseDown(content, { clientX: 10, clientY: 10, ctrlKey: true });
      fireEvent.mouseUp(content, { clientX: 10, clientY: 10, ctrlKey: true });
      fireEvent.click(content, { clientX: 10, clientY: 10, ctrlKey: true });

      await waitFor(() => {
        expect(useWorkspaceStore.getState().pendingLineTarget).toEqual({
          worktreeId: W1,
          path: "/main.ts",
          line: 6,
          matchText: null,
        });
      });
      expect(useWorkspaceStore.getState().pendingReferencesQuery).toBeNull();
    });

    // Bug fix: the cmd-hover underline was cleared the instant a click
    // fired, before the async go-to-def/references request even resolved —
    // jarring, since the click's effect (navigation, or opening references)
    // often doesn't visually register for a moment. It must persist through
    // the click itself.
    it("the cmd-hover underline persists through a click, not cleared immediately", async () => {
      const defSpy = vi.spyOn(lspApi, "getDefinition").mockResolvedValue({
        locations: [
          { external: false, path: "/target.ts", line: 10, character: 0, preview: "fn target()", confidence: "lsp" },
        ],
      });

      const code = "myFunc();\nconst y = 2;";
      // No `filePath`/`language` — keeps this test deterministic by never
      // triggering the async Shiki highlight effect, which would otherwise
      // replace this line's DOM (dangerouslySetInnerHTML) out from under the
      // manually-inserted hover-cue span at some unpredictable point.
      const { container } = render(
        <CodeView
          code={code}
          api={{}}
          worktreeId={W1}
          lspFileRef={{ kind: "workspace", path: "/main.ts" }}
        />
      );

      const content = container.querySelector(".workspace-code-content")!;
      expect(content.firstChild?.nodeType).toBe(Node.TEXT_NODE);

      // jsdom doesn't implement caretRangeFromPoint — stub it so the
      // cmd-hover underline logic (updateHoveredSymbolAt) has something to
      // resolve against, same as real pointer coordinates would in a browser.
      // Re-derives the current text node containing "myFunc" on EVERY call
      // (rather than capturing one node reference up front) because the
      // first call's own `range.surroundContents(span)` splits the original
      // text node into separate pieces — a stale captured reference would
      // point at a now-relocated/invalid node by the time the click fires
      // its own position lookup.
      // MUST be removed after this test (finally below) — left in place, it
      // would run against a different DOM entirely in a later test.
      const docWithCaret = document as unknown as {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      docWithCaret.caretRangeFromPoint = () => {
        const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const t = n as Text;
          const idx = t.textContent?.indexOf("myFunc") ?? -1;
          if (idx >= 0) {
            const range = document.createRange();
            range.setStart(t, idx + 2);
            range.setEnd(t, idx + 2);
            return range;
          }
        }
        return null;
      };

      try {
        fireEvent.mouseMove(content, { clientX: 10, clientY: 10, ctrlKey: true });

        const underline = container.querySelector(".workspace-code-symbol-hover");
        expect(underline).not.toBeNull();
        expect(underline?.textContent).toBe("myFunc");

        fireEvent.mouseDown(content, { clientX: 10, clientY: 10, ctrlKey: true });
        fireEvent.mouseUp(content, { clientX: 10, clientY: 10, ctrlKey: true });
        fireEvent.click(content, { clientX: 10, clientY: 10, ctrlKey: true });

        // Immediately after the click — before the async request resolves —
        // the underline must still be present.
        expect(container.querySelector(".workspace-code-symbol-hover")).not.toBeNull();

        // Let the click's async go-to-def chain fully settle before this
        // test returns — otherwise its pending promise/timeout work can run
        // during teardown or a later test, against an unmounted/different DOM.
        await waitFor(() => {
          expect(defSpy).toHaveBeenCalled();
        });
      } finally {
        delete docWithCaret.caretRangeFromPoint;
      }
    });

    // 5.T2: Hover pointer rest shows signature+doc; scrolling tooltip does not dismiss; scrolling container does
    it("5.T2: pointer rest over a symbol shows signature+doc; scrolling tooltip does not dismiss; scrolling container does", async () => {
      const hoverSpy = vi.spyOn(lspApi, "getHover").mockResolvedValue({
        signature: "fn hello() -> i32",
        doc: "Returns greeting number",
      });

      const code = "hello();";
      const { container } = render(
        <CodeView
          code={code}
          filePath="/main.rs"
          api={{}}
          worktreeId={W1}
          lspFileRef={{ kind: "workspace", path: "/main.rs" }}
        />
      );

      const content = container.querySelector(".workspace-code-content")!;
      fireEvent.pointerMove(content, { clientX: 20, clientY: 20 });

      // Tooltip should be visible with signature and doc after ~500ms pointer rest
      const tooltip = await screen.findByTestId("lsp-hover-tooltip", {}, { timeout: 2000 });
      expect(tooltip).toBeInTheDocument();
      expect(screen.getByText("fn hello() -> i32")).toBeInTheDocument();
      const docEl = screen.getByTestId("lsp-hover-doc");
      expect(docEl).toHaveTextContent("Returns greeting number");

      expect(hoverSpy).toHaveBeenCalledWith(
        expect.anything(),
        "worktree",
        W1,
        { kind: "workspace", path: "/main.rs" },
        0,
        0,
      );

      // Scrolling the tooltip's own text does NOT dismiss it
      fireEvent.scroll(docEl);
      expect(screen.getByTestId("lsp-hover-tooltip")).toBeInTheDocument();

      // Scrolling the code container dismisses it
      const pre = container.querySelector("pre.workspace-code-viewer")!;
      fireEvent.scroll(pre);
      expect(screen.queryByTestId("lsp-hover-tooltip")).toBeNull();
    });

    it("5.7: clicking 'Find references' in hover tooltip updates filesLeftPaneMode and pendingReferencesQuery", async () => {
      vi.spyOn(lspApi, "getHover").mockResolvedValue({
        signature: "fn hello() -> i32",
        doc: "Returns greeting number",
      });

      const code = "hello();";
      const { container } = render(
        <CodeView
          code={code}
          filePath="/main.rs"
          api={{}}
          worktreeId={W1}
          lspFileRef={{ kind: "workspace", path: "/main.rs" }}
        />
      );

      const content = container.querySelector(".workspace-code-content")!;
      fireEvent.pointerMove(content, { clientX: 20, clientY: 20 });

      const tooltip = await screen.findByTestId("lsp-hover-tooltip", {}, { timeout: 2000 });
      expect(tooltip).toBeInTheDocument();

      const findRefsBtn = screen.getByRole("button", { name: "Find references" });
      fireEvent.click(findRefsBtn);

      const store = useWorkspaceStore.getState();
      expect(store.filesLeftPaneMode[W1]).toBe("references");
      expect(store.pendingReferencesQuery).toEqual({
        worktreeId: W1,
        path: "/main.rs",
        line: 0,
        character: 0,
        symbol: "hello",
      });

      // Tooltip dismissed
      expect(screen.queryByTestId("lsp-hover-tooltip")).toBeNull();
    });
  });
});
