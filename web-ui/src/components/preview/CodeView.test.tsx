import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CodeView, type GutterMarkKind } from "./CodeView";
import { useWorkspaceStore } from "@/hooks/useStore";
import * as lspApi from "@/lib/lspApi";
import { ApiError } from "@/api/errors";

describe("CodeView", () => {
  it("5.T1: renders line with added modifier class when gutterMarks contains that line", () => {
    const code = "line 1\nline 2 added\nline 3";
    const gutterMarks = new Map<number, Set<GutterMarkKind>>([
      [2, new Set(["added"])],
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
    const gutterMarks = new Map<number, Set<GutterMarkKind>>([
      [2, new Set(["added"])],
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
    const gutterMarks = new Map<number, Set<GutterMarkKind>>([
      [1, new Set(["modified"])],
      [2, new Set(["deleted"])],
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
    const gutterMarks = new Map<number, Set<GutterMarkKind>>([
      [3, new Set(["modified"])],
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
    const gutterMarks = new Map<number, Set<GutterMarkKind>>([
      [1, new Set(["deleted"])],
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

  it("Bug 8: renders both modified and deleted modifier classes when gutterMarks contains a Set with both", () => {
    const code = "line 1\nline 2 mod+del\nline 3";
    const gutterMarks = new Map<number, Set<"added" | "modified" | "deleted">>([
      [2, new Set(["modified", "deleted"])],
    ]);
    const { container } = render(
      <CodeView
        code={code}
        gutterMarks={gutterMarks}
        filePath="test.txt"
      />
    );

    const lines = container.querySelectorAll(".workspace-code-line");
    expect(lines[1]!.className).toContain("workspace-code-line--modified");
    expect(lines[1]!.className).toContain("workspace-code-line--deleted");
  });

  it("Bug 8: renders both added and deleted modifier classes when gutterMarks contains a Set with both", () => {
    const code = "line 1\nline 2 add+del\nline 3";
    const gutterMarks = new Map<number, Set<"added" | "modified" | "deleted">>([
      [2, new Set(["added", "deleted"])],
    ]);
    const { container } = render(
      <CodeView
        code={code}
        gutterMarks={gutterMarks}
        filePath="test.txt"
      />
    );

    const lines = container.querySelectorAll(".workspace-code-line");
    expect(lines[1]!.className).toContain("workspace-code-line--added");
    expect(lines[1]!.className).toContain("workspace-code-line--deleted");
  });

  it("Bug 9: renders deleted-top modifier class when gutterMarks contains deleted-top", () => {
    const code = "line 1\nline 2\nline 3";
    const gutterMarks = new Map<number, Set<"added" | "modified" | "deleted" | "deleted-top">>([
      [1, new Set(["deleted-top"])],
    ]);
    const { container } = render(
      <CodeView
        code={code}
        gutterMarks={gutterMarks}
        filePath="test.txt"
      />
    );

    const lines = container.querySelectorAll(".workspace-code-line");
    expect(lines[0]!.className).toContain("workspace-code-line--deleted-top");
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

  // Bug 2 / L6: a column-pinned jump marks the referenced occurrence, not the
  // first `indexOf` on the line.
  it("highlightColumn/highlightEndColumn mark the exact occurrence, not the first", async () => {
    const code = "const a = run(); const b = run();";
    const second = code.lastIndexOf("run");
    const { container } = render(
      <CodeView
        code={code}
        filePath="test.ts"
        highlightLine={1}
        highlightMatchText="run"
        highlightColumn={second}
        highlightEndColumn={second + 3}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector(".workspace-code-content--shiki mark.workspace-code-match")).toBeTruthy();
    });
    const content = container.querySelector(".workspace-code-content")!;
    const mark = content.querySelector("mark.workspace-code-match")!;
    expect(mark.textContent).toBe("run");
    // Everything before the mark is the text up to the SECOND occurrence.
    const range = document.createRange();
    range.setStart(content, 0);
    range.setEndBefore(mark);
    expect(range.toString()).toBe(code.slice(0, second));
  });

  it("highlightColumn without endColumn marks the identifier starting at that column", () => {
    const code = "let x = foo.barBaz(1);";
    const col = code.indexOf("barBaz");
    const { container } = render(
      <CodeView code={code} filePath="test.txt" highlightLine={1} highlightColumn={col} />,
    );
    expect(container.querySelector("mark.workspace-code-match")?.textContent).toBe("barBaz");
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
      expect(screen.queryByTestId("lsp-picker-reason")).toBeNull();
    });

    // Bug 6: a text-search fallback says WHY in the header, drops the
    // per-row badges, trims raw previews, and still shows the picker for a
    // single hit (never a silent jump to a grep match).
    it("text-fallback answer: reason line, no per-row badges, trimmed preview, picker even for one hit", async () => {
      const locations: lspApi.Location[] = [
        {
          external: false,
          path: "/src/alpha.ts",
          line: 10,
          character: 9,
          endCharacter: 14,
          preview: "export function alpha() {",
          confidence: "text",
        },
      ];
      vi.spyOn(lspApi, "getDefinition").mockResolvedValue({ locations, fallback: { reason: "starting" } });
      // Indented raw preview to prove client-side trimming.
      locations[0]!.preview = "    export function alpha() {";

      const code = "alpha();\nconst y = 2;";
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
      expect(screen.getByTestId("lsp-picker-reason")).toHaveTextContent(
        "Language server starting — text matches",
      );
      expect(screen.getByText("Go to definition · 1")).toBeInTheDocument();
      expect(screen.queryByText("(text match)")).toBeNull();
      expect(screen.getByText("export function alpha() {")).toBeInTheDocument();
      // No silent navigation happened.
      expect(useWorkspaceStore.getState().activeFilePath).toBe("/main.ts");
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

    it("3.T5b: a superseded request's late error does not open the references panel", async () => {
      let rejectDef!: (err: unknown) => void;
      vi.spyOn(lspApi, "getDefinition").mockReturnValue(
        new Promise<lspApi.LspDefinitionResponse>((_res, rej) => {
          rejectDef = rej;
        }),
      );

      const { container, rerender } = render(
        <CodeView
          code={"const x = 1;\nconst y = 2;"}
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

      // File switch supersedes the in-flight request.
      rerender(
        <CodeView
          code="different content"
          filePath="/other.ts"
          api={{}}
          worktreeId={W1}
          lspFileRef={{ kind: "workspace", path: "/other.ts" }}
        />
      );
      rejectDef(new ApiError("boom", 500));
      await new Promise((r) => setTimeout(r, 20));

      expect(useWorkspaceStore.getState().pendingReferencesQuery).toBeNull();
      expect(useWorkspaceStore.getState().filesLeftPaneMode[W1]).not.toBe("references");
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

    // Bug 11: 409 failing twice opens References panel via revealReferences (replacing tooltip-only feedback)
    it("Bug 11: 409 failing twice opens References panel via revealReferences", async () => {
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

      await waitFor(() => {
        expect(useWorkspaceStore.getState().filesLeftPaneMode[W1]).toBe("references");
      });
      expect(useWorkspaceStore.getState().pendingReferencesQuery?.symbol).toBe("const");
      expect(useWorkspaceStore.getState().peekFile).toBeNull();
      expect(useWorkspaceStore.getState().activeFilePath).toBe("/main.ts");
      expect(useWorkspaceStore.getState().openFileTabsByWorktree[W1]).toEqual(["/main.ts"]);
    });

    it("3.8b: zero text-fallback hits while the server never ran (starting) opens a references query, not no-definition", async () => {
      vi.spyOn(lspApi, "getDefinition").mockResolvedValue({ locations: [], fallback: { reason: "starting" } });
      const { container } = render(
        <CodeView
          code={"const x = 1;\nconst y = 2;"}
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

      await waitFor(() => expect(useWorkspaceStore.getState().pendingReferencesQuery?.symbol).toBe("const"));
      expect(useWorkspaceStore.getState().pendingReferencesQuery?.intent).toBe("references");
    });

    // 3.8 (round-2 Bug 1): zero results -> References panel in its
    // "Couldn't resolve" (no-definition) state, NOT a references query.
    it("3.8: zero results (locations: []) opens the panel with intent no-definition", async () => {
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
        expect(useWorkspaceStore.getState().filesLeftPaneMode[W1]).toBe("references");
      });
      expect(useWorkspaceStore.getState().pendingReferencesQuery?.symbol).toBe("const");
      expect(useWorkspaceStore.getState().pendingReferencesQuery?.intent).toBe("no-definition");
      expect(useWorkspaceStore.getState().peekFile).toBeNull();
      expect(useWorkspaceStore.getState().activeFilePath).toBe("/main.ts");
      expect(useWorkspaceStore.getState().openFileTabsByWorktree[W1]).toEqual(["/main.ts"]);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    describe("server_failed (latched language-server failure)", () => {
      const failure: lspApi.LspFailure = {
        kind: "missing_dependency",
        summary: "TypeScript isn't installed for this project — code navigation needs it.",
        message: null,
        remediation: [{ kind: "retry", label: "Retry" }],
        autoRetry: true,
      };
      const failedStatus: lspApi.LspStatusResponse = {
        status: "error",
        language: "typescript",
        displayName: "TypeScript / JavaScript",
        label: "Setup needed",
        severity: "warn",
        detail: failure.summary,
        action: "retry",
        actionLabel: "Retry",
        failure,
      };
      const clickAt = (container: HTMLElement) => {
        const content = container.querySelector(".workspace-code-content")!;
        fireEvent.mouseDown(content, { clientX: 50, clientY: 50, ctrlKey: true });
        fireEvent.mouseUp(content, { clientX: 50, clientY: 50, ctrlKey: true });
        fireEvent.click(content, { clientX: 50, clientY: 50, ctrlKey: true });
      };
      const renderView = () =>
        render(
          <CodeView
            code={"alpha();\nconst y = 2;"}
            filePath="/main.ts"
            api={{}}
            worktreeId={W1}
            lspFileRef={{ kind: "workspace", path: "/main.ts" }}
          />
        );

      it("text hits: picker header names the missing thing from the failure summary", async () => {
        vi.spyOn(lspApi, "getDefinition").mockResolvedValue({
          locations: [
            {
              external: false,
              path: "/src/alpha.ts",
              line: 10,
              character: 16,
              endCharacter: 21,
              preview: "export function alpha() {",
              confidence: "text",
            },
          ],
          fallback: { reason: "server_failed" },
        });
        vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(failedStatus);
        const { container } = renderView();
        clickAt(container);
        expect(await screen.findByRole("dialog", { name: "Go to definition" })).toBeInTheDocument();
        expect(screen.getByTestId("lsp-picker-reason")).toHaveTextContent(
          "TypeScript isn't installed for this project — text matches",
        );
      });

      it("zero text hits: opens References carrying the failure (S17), not plain no-definition", async () => {
        vi.spyOn(lspApi, "getDefinition").mockResolvedValue({ locations: [], fallback: { reason: "server_failed" } });
        vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(failedStatus);
        const { container } = renderView();
        clickAt(container);
        await waitFor(() => expect(useWorkspaceStore.getState().pendingReferencesQuery?.failure).toEqual(failure));
        expect(useWorkspaceStore.getState().pendingReferencesQuery?.intent).toBe("no-definition");
        expect(screen.queryByRole("dialog")).toBeNull();
      });

      it("a 503 LSP_SERVER_FAILED opens References with the failure, without retrying as 'starting'", async () => {
        const spy = vi.spyOn(lspApi, "getDefinition").mockRejectedValue(
          new ApiError(JSON.stringify({ error: failure.summary, code: "LSP_SERVER_FAILED", failure }), 503),
        );
        const { container } = renderView();
        clickAt(container);
        await waitFor(() => expect(useWorkspaceStore.getState().pendingReferencesQuery?.failure).toEqual(failure));
        expect(useWorkspaceStore.getState().pendingReferencesQuery?.intent).toBe("no-definition");
        expect(spy).toHaveBeenCalledTimes(1);
        expect(screen.queryByText("waiting for language server…")).toBeNull();
      });
    });

    it("Bug 11: 409 LSP_DISABLED is not retried and directly opens references panel", async () => {
      const defSpy = vi.spyOn(lspApi, "getDefinition").mockRejectedValue(
        new ApiError(JSON.stringify({ error: "Code navigation is disabled", code: "LSP_DISABLED" }), 409)
      );

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
        expect(defSpy).toHaveBeenCalledTimes(1);
        expect(useWorkspaceStore.getState().filesLeftPaneMode[W1]).toBe("references");
      });
      expect(useWorkspaceStore.getState().pendingReferencesQuery?.symbol).toBe("const");
    });

    it("Bug 11: 422 LSP_UNSUPPORTED opens references panel without retry", async () => {
      const defSpy = vi.spyOn(lspApi, "getDefinition").mockRejectedValue(
        new ApiError(JSON.stringify({ error: "unsupported", code: "LSP_UNSUPPORTED" }), 422)
      );

      const code = "const x = 1;\nconst y = 2;";
      const { container } = render(
        <CodeView
          code={code}
          filePath="/main.txt"
          api={{}}
          worktreeId={W1}
          lspFileRef={{ kind: "workspace", path: "/main.txt" }}
        />
      );

      const content = container.querySelector(".workspace-code-content")!;
      fireEvent.mouseDown(content, { clientX: 50, clientY: 50, ctrlKey: true });
      fireEvent.mouseUp(content, { clientX: 50, clientY: 50, ctrlKey: true });
      fireEvent.click(content, { clientX: 50, clientY: 50, ctrlKey: true });

      await waitFor(() => {
        expect(defSpy).toHaveBeenCalledTimes(1);
        expect(useWorkspaceStore.getState().filesLeftPaneMode[W1]).toBe("references");
      });
      expect(useWorkspaceStore.getState().pendingReferencesQuery?.symbol).toBe("const");
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
        // Self-definition is the ONE case that becomes a references query.
        intent: "references",
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
        expect(useWorkspaceStore.getState().pendingLineTarget).toMatchObject({
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
      // The reveal must not flip the persisted fileTreeVisible preference.
      useWorkspaceStore.setState({ fileTreeVisible: false });
      fireEvent.click(findRefsBtn);

      const store = useWorkspaceStore.getState();
      expect(store.layoutByWorktree[W1]?.toolPanelVisible).toBe(true);
      expect(store.layoutByWorktree[W1]?.toolPanelTab).toBe("files");
      expect(store.fileTreeVisible).toBe(false);
      expect(store.filesLeftPaneMode[W1]).toBe("references");
      expect(store.pendingReferencesQuery).toEqual({
        worktreeId: W1,
        path: "/main.rs",
        line: 0,
        character: 0,
        symbol: "hello",
        intent: "references",
      });

      // Tooltip dismissed
      expect(screen.queryByTestId("lsp-hover-tooltip")).toBeNull();
    });
  });

  // ── Phase 3 — virtual mode (3.T2/3.T3/3.T5/3.T5b) ─────────────────────────
  // jsdom has no layout, so the virtualizer needs stubbed scroller geometry to
  // compute a real viewport (same mechanism as MessageList.test.tsx's
  // `stubScroller`).
  function makeScroller() {
    const el = document.createElement("div");
    el.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 800, bottom: 500, width: 800, height: 500, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    Object.defineProperty(el, "clientHeight", { value: 500, configurable: true });
    Object.defineProperty(el, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(el, "offsetHeight", { value: 500, configurable: true });
    Object.defineProperty(el, "offsetTop", { value: 0, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: 2_000_000, configurable: true });
    return el;
  }

  function bigCode(lines: number): string {
    return Array.from({ length: lines }, (_, i) => `const line${i} = ${i};`).join("\n");
  }

  describe("Phase 3 — virtual mode", () => {
    const W1 = "wt-1";

    it("3.T2 — with 50,000 lines and no language, mounted .workspace-code-line rows stay < 200 (windowed)", async () => {
      const scroller = makeScroller();
      const { container } = render(
        <CodeView code={bigCode(50_000)} scrollElRef={{ current: scroller }} />,
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      // Sizer present + rows windowed.
      expect(container.querySelector(".workspace-code-sizer")).toBeTruthy();
      expect(container.querySelector(".workspace-code-viewer--virtual")).toBeTruthy();
      const rows = container.querySelectorAll(".workspace-code-line");
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(200);
    });

    it("3.T3 — highlightLine=31204: row is mounted after first commit and onRevealReady fires (scrollToIndex path)", async () => {
      const scroller = makeScroller();
      const onRevealReady = vi.fn();
      const { container } = render(
        <CodeView
          code={bigCode(40_000)}
          scrollElRef={{ current: scroller }}
          highlightLine={31204}
          onRevealReady={onRevealReady}
        />,
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      const target = container.querySelector('[data-line="31204"]');
      expect(target).toBeTruthy();
      expect(target).toHaveClass("workspace-code-line--target");
      // `onRevealReady` is called by CodeView right after `scrollToIndex(...,
      // { align: "center" })`, so this asserts the scroll-to-line path ran.
      expect(onRevealReady).toHaveBeenCalled();
    });

    it("column-pinned jump to a windowed-out row marks exactly that column range once mounted", async () => {
      const scroller = makeScroller();
      const onRevealReady = vi.fn();
      const { container } = render(
        <CodeView
          code={bigCode(40_000)}
          scrollElRef={{ current: scroller }}
          highlightLine={31204}
          highlightColumn={6}
          highlightEndColumn={15}
          onRevealReady={onRevealReady}
        />,
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(onRevealReady).toHaveBeenCalled();
      const marks = container.querySelectorAll('[data-line="31204"] mark.workspace-code-match');
      expect(marks).toHaveLength(1);
      expect(marks[0]!.textContent).toBe("line31203");
    });

    it("3.T5 — LSP ctrl-click on a mounted row in virtual mode resolves the correct 0-indexed line", async () => {
      const scroller = makeScroller();
      const defSpy = vi.spyOn(lspApi, "getDefinition").mockResolvedValue({
        locations: [
          { external: false, path: "/def.ts", line: 0, character: 0, preview: "fn", confidence: "lsp" },
        ],
      });
      useWorkspaceStore.setState({
        activeWorktreeId: W1,
        activeFilePath: "/big.ts",
        openFileTabsByWorktree: { [W1]: ["/big.ts"] },
        activeFileTabIdxByWorktree: { [W1]: 0 },
        peekFile: null,
        backStack: {},
        forwardStack: {},
        pendingLineTarget: null,
      });
      const code = bigCode(50_000);
      const { container } = render(
        <CodeView
          code={code}
          scrollElRef={{ current: scroller }}
          filePath="/big.ts"
          api={{}}
          worktreeId={W1}
          lspFileRef={{ kind: "workspace", path: "/big.ts" }}
        />,
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      const row = container.querySelector<HTMLElement>('[data-line="5"]');
      expect(row).toBeTruthy();
      const content = row!.querySelector<HTMLElement>(".workspace-code-content")!;
      fireEvent.mouseDown(content, { clientX: 10, clientY: 10, ctrlKey: true });
      fireEvent.mouseUp(content, { clientX: 10, clientY: 10, ctrlKey: true });
      fireEvent.click(content, { clientX: 10, clientY: 10, ctrlKey: true });
      await waitFor(() => {
        expect(defSpy).toHaveBeenCalled();
      }, { timeout: 8000 });
      // data-line=5 → 0-indexed line 4.
      expect(defSpy).toHaveBeenCalledWith(expect.anything(), "worktree", W1, { kind: "workspace", path: "/big.ts" }, 4, expect.any(Number));
    }, 15_000);

    it("3.T5b — Ctrl+A then copy in virtual mode puts the full code on the clipboard", async () => {
      const scroller = makeScroller();
      const code = bigCode(50_000);
      const { container } = render(
        <CodeView code={code} scrollElRef={{ current: scroller }} />,
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      const pre = container.querySelector("pre.workspace-code-viewer")!;
      // Pointer enters so the viewer counts as "inside" for Ctrl+A.
      fireEvent.pointerEnter(pre);
      fireEvent.keyDown(window, { key: "a", ctrlKey: true });

      const clipData: Record<string, string> = {};
      const copyEvent = new Event("copy", { bubbles: true, cancelable: true }) as Event & {
        clipboardData: { setData: (type: string, val: string) => void };
      };
      copyEvent.clipboardData = {
        setData: (type: string, val: string) => {
          clipData[type] = val;
        },
      };
      pre.dispatchEvent(copyEvent);

      expect(copyEvent.defaultPrevented).toBe(true);
      expect(clipData["text/plain"]).toBe(code);
    });
  });

  describe("Bug 10: Cmd+hover underline flicker fix", () => {
    const W1 = "wt-1";

    it("same-word moves cause zero DOM writes on code lines", () => {
      const code = "myFunc();\nconst y = 2;";
      const { container } = render(
        <CodeView code={code} api={{}} worktreeId={W1} filePath="/main.rs" />
      );

      const content = container.querySelector(".workspace-code-content")!;
      const doc = document as unknown as {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      doc.caretRangeFromPoint = () => {
        const textNode = Array.from(content.childNodes).find(
          (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.includes("myFunc")
        );
        if (!textNode) return null;
        const range = document.createRange();
        range.setStart(textNode, 2);
        range.setEnd(textNode, 2);
        return range;
      };

      try {
        // Initial move to highlight myFunc
        act(() => {
          fireEvent.mouseMove(content, { clientX: 10, clientY: 10, ctrlKey: true });
        });
        const underline = container.querySelector(".workspace-code-symbol-hover");
        expect(underline?.textContent).toBe("myFunc");

        // Observe any DOM mutations on the code line content
        const mutations: MutationRecord[] = [];
        const observer = new MutationObserver((records) => {
          mutations.push(...records);
        });
        observer.observe(content, { childList: true, subtree: true, characterData: true });

        // Fire 5 more moves over the same word
        act(() => {
          for (let i = 0; i < 5; i++) {
            fireEvent.mouseMove(content, { clientX: 10 + i, clientY: 10, ctrlKey: true });
          }
        });

        observer.disconnect();
        expect(mutations.length).toBe(0);
      } finally {
        delete doc.caretRangeFromPoint;
      }
    });

    it("cue survives a React re-render", () => {
      const code = "myFunc();\nconst y = 2;";
      const { container, rerender } = render(
        <CodeView code={code} api={{}} worktreeId={W1} filePath="/main.rs" />
      );

      const content = container.querySelector(".workspace-code-content")!;
      const doc = document as unknown as {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      doc.caretRangeFromPoint = () => {
        const textNode = Array.from(content.childNodes).find(
          (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.includes("myFunc")
        );
        if (!textNode) return null;
        const range = document.createRange();
        range.setStart(textNode, 2);
        range.setEnd(textNode, 2);
        return range;
      };

      try {
        act(() => {
          fireEvent.mouseMove(content, { clientX: 10, clientY: 10, ctrlKey: true });
        });
        const underline = container.querySelector(".workspace-code-symbol-hover");
        expect(underline?.textContent).toBe("myFunc");

        // Force a re-render of CodeView with updated props
        act(() => {
          rerender(
            <CodeView code={code} api={{}} worktreeId={W1} filePath="/main.rs" highlightLine={2} />
          );
        });

        // Cue must survive re-render
        const underlineAfter = container.querySelector(".workspace-code-symbol-hover");
        expect(underlineAfter?.textContent).toBe("myFunc");
      } finally {
        delete doc.caretRangeFromPoint;
      }
    });

    it("uses CSS Custom Highlight API when available", () => {
      const code = "myFunc();\nconst y = 2;";
      const setMock = vi.fn();
      const deleteMock = vi.fn();

      const originalCSS = globalThis.CSS;
      const g = globalThis as unknown as Record<string, unknown>;
      const originalHighlight = g.Highlight;

      g.Highlight = class MockHighlight {
        ranges: Range[];
        constructor(...ranges: Range[]) {
          this.ranges = ranges;
        }
      };

      g.CSS = {
        ...originalCSS,
        highlights: {
          set: setMock,
          delete: deleteMock,
        },
      };

      const { container } = render(
        <CodeView code={code} api={{}} worktreeId={W1} filePath="/main.rs" />
      );

      const content = container.querySelector(".workspace-code-content")!;
      const doc = document as unknown as {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      doc.caretRangeFromPoint = () => {
        const textNode = Array.from(content.childNodes).find(
          (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.includes("myFunc")
        );
        if (!textNode) return null;
        const range = document.createRange();
        range.setStart(textNode, 2);
        range.setEnd(textNode, 2);
        return range;
      };

      try {
        act(() => {
          fireEvent.mouseMove(content, { clientX: 10, clientY: 10, ctrlKey: true });
        });

        expect(setMock).toHaveBeenCalledWith("lsp-cue", expect.any(g.Highlight as new (...r: Range[]) => object));

        // Release modifier clears highlight
        act(() => {
          fireEvent.keyUp(window, { key: "Control", ctrlKey: false, metaKey: false });
        });
        expect(deleteMock).toHaveBeenCalledWith("lsp-cue");
      } finally {
        delete doc.caretRangeFromPoint;
        if (originalCSS) {
          g.CSS = originalCSS;
        } else {
          delete g.CSS;
        }
        if (originalHighlight) {
          g.Highlight = originalHighlight;
        } else {
          delete g.Highlight;
        }
      }
    });
  });
});

