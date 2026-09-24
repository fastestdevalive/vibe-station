import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReferencesPanel } from "./ReferencesPanel";
import { useWorkspaceStore } from "@/hooks/useStore";
import * as lspApi from "@/lib/lspApi";

describe("ReferencesPanel", () => {
  const W1 = "wt-1";

  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: W1,
      peekFile: null,
      pendingReferencesQuery: null,
      filesLeftPaneMode: { [W1]: "tree" },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 5.T3: "Find references" flow with mounted-but-hidden panel
  it("5.T3: panel mounted-hidden does not fetch on mount; pendingReferencesQuery changing triggers fetch and clears query", async () => {
    const refsSpy = vi.spyOn(lspApi, "getReferences").mockResolvedValue({
      references: [
        {
          path: "/src/main.rs",
          external: false,
          token: null,
          displayPath: null,
          entries: [
            { line: 10, character: 4, preview: "fn run() {", isDeclaration: true, confidence: "lsp" },
            { line: 25, character: 8, preview: "  run();", isDeclaration: false, confidence: "lsp" },
          ],
        },
      ],
      hasMore: false,
      cursor: null,
    });

    // Render mounted-but-hidden first
    const { container } = render(
      <div className="files-left-pane__hidden" style={{ display: "none" }}>
        <ReferencesPanel api={{}} worktreeId={W1} />
      </div>
    );

    // Initial mount with no pending query: no fetch fired
    expect(refsSpy).not.toHaveBeenCalled();
    expect(screen.getByText("No symbol selected")).toBeInTheDocument();

    // Trigger "Find references" by setting pendingReferencesQuery
    useWorkspaceStore.getState().setPendingReferencesQuery({
      worktreeId: W1,
      path: "/src/main.rs",
      line: 10,
      character: 4,
      symbol: "run",
    });

    // Assert getReferences is called with the query parameters
    await waitFor(() => {
      expect(refsSpy).toHaveBeenCalledWith(
        expect.anything(),
        "worktree",
        W1,
        { kind: "workspace", path: "/src/main.rs" },
        10,
        4,
        null,
      );
    });

    // Assert pendingReferencesQuery was cleared after consumption (read-once)
    expect(useWorkspaceStore.getState().pendingReferencesQuery).toBeNull();

    // References rendered in header
    expect(await screen.findByText("References: run (2)")).toBeInTheDocument();
  });

  // "Find references" on an EXTERNAL file (opened via go-to-definition into
  // e.g. node_modules / a system path) must build an `{ kind: "external", token }`
  // LSP file ref, NOT a workspace-path request — which path-confinement now
  // correctly rejects for absolute/escaping paths.
  it("builds an external LSP file ref when the pending query carries an external field", async () => {
    const refsSpy = vi.spyOn(lspApi, "getReferences").mockResolvedValue({
      references: [],
      hasMore: false,
      cursor: null,
    });

    useWorkspaceStore.getState().setPendingReferencesQuery({
      worktreeId: W1,
      path: "/node_modules/foo/dist/foo.js",
      line: 12,
      character: 3,
      symbol: "bar",
      external: {
        token: "ext-token-9",
        displayPath: "/node_modules/foo/dist/foo.js",
      },
    });

    render(<ReferencesPanel api={{}} worktreeId={W1} />);

    await waitFor(() => {
      expect(refsSpy).toHaveBeenCalledWith(
        expect.anything(),
        "worktree",
        W1,
        { kind: "external", token: "ext-token-9" },
        12,
        3,
        null,
      );
    });

    // The workspace shape must NOT be used for an external query.
    expect(refsSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      "worktree",
      W1,
      { kind: "workspace", path: "/node_modules/foo/dist/foo.js" },
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  // 5.T4: References list row clicks (workspace and external)
  it("5.T4: clicking a non-declaration row updates peekFile; external rows support token or placeholder", async () => {
    vi.spyOn(lspApi, "getReferences").mockResolvedValue({
      references: [
        {
          path: "/src/worker.rs",
          external: false,
          token: null,
          displayPath: null,
          entries: [
            { line: 15, character: 2, preview: "worker.run()", isDeclaration: false, confidence: "lsp" },
          ],
        },
        {
          path: null,
          external: true,
          token: "tok-ext-1",
          displayPath: "/sys/core.rs",
          entries: [
            { line: 40, character: 0, preview: "core::run()", isDeclaration: false, confidence: "lsp" },
          ],
        },
        {
          path: null,
          external: true,
          token: null,
          displayPath: "/sys/unsupported.rs",
          entries: [
            { line: 99, character: 0, preview: "unsupported::run()", isDeclaration: false, confidence: "lsp" },
          ],
        },
      ],
      hasMore: false,
      cursor: null,
    });

    useWorkspaceStore.getState().setPendingReferencesQuery({
      worktreeId: W1,
      path: "/src/main.rs",
      line: 1,
      character: 0,
      symbol: "run",
    });

    render(<ReferencesPanel api={{}} worktreeId={W1} />);

    // Wait for entries to render
    const workerEntry = await screen.findByText("worker.run()");
    expect(workerEntry).toBeInTheDocument();

    // 1. Click in-workspace non-declaration row
    fireEvent.click(workerEntry);
    expect(useWorkspaceStore.getState().openFileTabsByWorktree[W1]).toContain("/src/worker.rs");
    expect(useWorkspaceStore.getState().activeFilePath).toBe("/src/worker.rs");
    const tabs = useWorkspaceStore.getState().openFileTabsByWorktree[W1] ?? [];
    expect(useWorkspaceStore.getState().activeFileTabIdxByWorktree[W1]).toBe(tabs.indexOf("/src/worker.rs"));
    expect(useWorkspaceStore.getState().peekFile).toBeNull();

    // 2. Click external row with token (Phase 4 landed)
    const extEntry = screen.getByText("core::run()");
    fireEvent.click(extEntry);
    expect(useWorkspaceStore.getState().peekFile).toEqual({
      worktreeId: W1,
      path: "/sys/core.rs",
      line: 41,
      matchText: null,
      source: "references",
      external: {
        token: "tok-ext-1",
        displayPath: "/sys/core.rs",
      },
    });

    // 3. Click external row with token: null (Phase 4 stubbed absent)
    const noTokenEntry = screen.getByText("unsupported::run()");
    fireEvent.click(noTokenEntry);
    expect(
      screen.getByText("Definition is outside this workspace — external file viewing not yet available")
    ).toBeInTheDocument();
  });

  // 5.T5: Zero references found
  it("5.T5: zero references found displays 'No references found for `run`'", async () => {
    vi.spyOn(lspApi, "getReferences").mockResolvedValue({
      references: [],
      hasMore: false,
      cursor: null,
    });

    useWorkspaceStore.getState().setPendingReferencesQuery({
      worktreeId: W1,
      path: "/src/main.rs",
      line: 10,
      character: 4,
      symbol: "run",
    });

    render(<ReferencesPanel api={{}} worktreeId={W1} />);

    expect(await screen.findByText("No references found for `run`")).toBeInTheDocument();
  });

  it("renders text match badge when entry confidence is text", async () => {
    vi.spyOn(lspApi, "getReferences").mockResolvedValue({
      references: [
        {
          path: "/src/main.rs",
          external: false,
          token: null,
          displayPath: null,
          entries: [
            { line: 10, character: 4, preview: "fn run() {", isDeclaration: false, confidence: "text" },
          ],
        },
      ],
      hasMore: false,
      cursor: null,
    });

    useWorkspaceStore.getState().setPendingReferencesQuery({
      worktreeId: W1,
      path: "/src/main.rs",
      line: 10,
      character: 4,
      symbol: "run",
    });

    render(<ReferencesPanel api={{}} worktreeId={W1} />);

    expect(await screen.findByTitle("Text match (LSP not available)")).toBeInTheDocument();
    expect(screen.getByText("text")).toBeInTheDocument();
  });

  // Follow-up: reference previews should be syntax-highlighted like the code
  // viewer, not flat plain text — matching language + the active theme.
  it("syntax-highlights each reference's preview line", async () => {
    vi.spyOn(lspApi, "getReferences").mockResolvedValue({
      references: [
        {
          path: "/src/main.rs",
          external: false,
          token: null,
          displayPath: null,
          entries: [
            { line: 10, character: 4, preview: "fn run() {", isDeclaration: true, confidence: "lsp" },
          ],
        },
      ],
      hasMore: false,
      cursor: null,
    });

    useWorkspaceStore.getState().setPendingReferencesQuery({
      worktreeId: W1,
      path: "/src/main.rs",
      line: 10,
      character: 4,
      symbol: "run",
    });

    render(<ReferencesPanel api={{}} worktreeId={W1} />);

    // Plain text renders first (before the async Shiki tokenize resolves).
    const row = await screen.findByText("fn run() {");
    expect(row).toHaveClass("references-panel__preview");

    // Once highlighted, the preview text is still present but now wrapped
    // in per-token colored spans (real markup, not the plain text node).
    await waitFor(() => {
      const preview = document.querySelector(".references-panel__preview");
      expect(preview?.innerHTML).toContain("<span");
      expect(preview?.textContent).toBe("fn run() {");
    });
  });
});
