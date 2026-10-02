import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReferencesPanel } from "./ReferencesPanel";
import { useWorkspaceStore } from "@/hooks/useStore";
import { ApiError } from "@/api/errors";
import * as lspApi from "@/lib/lspApi";

const headerTitle = () => document.querySelector(".references-panel__title")?.textContent ?? null;
const countPill = () => document.querySelector(".references-panel__count-pill")?.textContent ?? null;
const chipWord = () => document.querySelector(".references-panel__chip-word")?.textContent ?? null;

async function expectResults(symbol: string, count: string, timeout = 1000) {
  await waitFor(
    () => {
      expect(headerTitle()).toBe(symbol);
      expect(countPill()).toBe(count);
    },
    { timeout },
  );
}

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

    // Header: symbol + count pill + status chip — no sentence.
    await expectResults("run", "2");
    expect(chipWord()).toBe("LSP");
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
    const workerEntry = await screen.findByText((_, el) => !!el?.classList.contains("references-panel__preview") && el.textContent === "worker.run()");
    expect(workerEntry).toBeInTheDocument();

    // 1. Click in-workspace non-declaration row
    fireEvent.click(workerEntry);
    expect(useWorkspaceStore.getState().openFileTabsByWorktree[W1]).toContain("/src/worker.rs");
    expect(useWorkspaceStore.getState().activeFilePath).toBe("/src/worker.rs");
    const tabs = useWorkspaceStore.getState().openFileTabsByWorktree[W1] ?? [];
    expect(useWorkspaceStore.getState().activeFileTabIdxByWorktree[W1]).toBe(tabs.indexOf("/src/worker.rs"));
    expect(useWorkspaceStore.getState().peekFile).toBeNull();

    // 2. Click external row with token (Phase 4 landed)
    const extEntry = screen.getByText((_, el) => !!el?.classList.contains("references-panel__preview") && el.textContent === "core::run()");
    fireEvent.click(extEntry);
    expect(useWorkspaceStore.getState().peekFile).toMatchObject({
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
    const noTokenEntry = screen.getByText((_, el) => !!el?.classList.contains("references-panel__preview") && el.textContent === "unsupported::run()");
    fireEvent.click(noTokenEntry);
    // S14: an inline row-level notice, not a panel-wide banner.
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent(/Outside workspace/);
    expect(notice.closest(".references-panel__row")).toBe(noTokenEntry.closest(".references-panel__row"));
  });

  // 5.T5: Zero references found
  it("5.T5 / S10: zero references shows a 0 count and 'No references to run'", async () => {
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

    expect(await screen.findByText(/No references to/)).toBeInTheDocument();
    expect(screen.getByText("run", { selector: "code" })).toBeInTheDocument();
    expect(countPill()).toBe("0");
  });

  it("renders the per-row text badge only in a MIXED lsp/text list", async () => {
    vi.spyOn(lspApi, "getReferences").mockResolvedValue({
      references: [
        {
          path: "/src/main.rs",
          external: false,
          token: null,
          displayPath: null,
          entries: [
            { line: 10, character: 4, preview: "fn run() {", isDeclaration: false, confidence: "text" },
            { line: 12, character: 4, preview: "    run();", isDeclaration: false, confidence: "lsp" },
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

    expect(await screen.findByTitle("Text match (not confirmed by the language server)")).toBeInTheDocument();
    expect(screen.getAllByText("text")).toHaveLength(1);
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

    // Preview renders (with match token marked, before the async Shiki tokenize resolves).
    const row = await screen.findByText((_, el) => !!el?.classList.contains("references-panel__preview") && el.textContent === "fn run() {");
    expect(row).toHaveClass("references-panel__preview");

    // Once highlighted, the preview text is still present but now wrapped
    // in per-token colored spans (real markup, not the plain text node).
    await waitFor(() => {
      const preview = document.querySelector(".references-panel__preview");
      expect(preview?.innerHTML).toContain("<span");
      expect(preview?.textContent).toBe("fn run() {");
    });
  });

  describe("Bug 2 — LSP status banners and in-panel actions", () => {
    it("renders 'Code navigation is disabled' banner with Enable button when LSP is disabled", async () => {
      const setWorktreeLspEnabled = vi.fn().mockResolvedValue({});
      vi.spyOn(lspApi, "getReferences").mockRejectedValue(
        new ApiError(JSON.stringify({ error: "Code navigation is disabled", code: "LSP_DISABLED" }), 409)
      );
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
        status: "disabled",
        language: "rust",
        displayName: "Rust",
        label: "Disabled",
        severity: "neutral",
        detail: "Code navigation is disabled",
        action: "enable",
        actionLabel: "Enable",
      });

      useWorkspaceStore.getState().setPendingReferencesQuery({
        worktreeId: W1,
        path: "/src/main.rs",
        line: 10,
        character: 4,
        symbol: "disabled_sym",
      });

      render(<ReferencesPanel api={{ setWorktreeLspEnabled }} worktreeId={W1} />);

      expect(await screen.findByText("Code navigation is off.")).toBeInTheDocument();
      expect(chipWord()).toBe("Off");
      const enableBtn = screen.getByRole("button", { name: "Enable" });
      expect(enableBtn).toBeInTheDocument();

      fireEvent.click(enableBtn);
      await waitFor(() => {
        expect(setWorktreeLspEnabled).toHaveBeenCalledWith(W1, true);
      });
    });

    it("renders the query's own error (details disclosure) with Refresh when the server stops mid-query", async () => {
      // The query's own result outranks the polled status: a failed query
      // shows its error banner even when the poll says "stopped".
      vi.spyOn(lspApi, "getReferences").mockRejectedValue(
        new Error("Language server stopped")
      );
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
        status: "stopped",
        language: "rust",
        displayName: "Rust",
        label: "Stopped",
        severity: "neutral",
        detail: "Language server stopped",
        action: "resume",
        actionLabel: "Resume",
      });

      useWorkspaceStore.getState().setPendingReferencesQuery({
        worktreeId: W1,
        path: "/src/main.rs",
        line: 10,
        character: 4,
        symbol: "stopped_sym",
      });

      render(<ReferencesPanel api={{}} worktreeId={W1} />);

      expect(await screen.findByText("Language server error.")).toBeInTheDocument();
      expect(screen.getByText("Language server stopped", { selector: "pre" })).toBeInTheDocument();
      expect(chipWord()).toBe("Error");
      expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    });

    it("renders 'No language server on this host' from the polled not_found status when the query finds nothing", async () => {
      // A missing server binary is reported through the polled `not_found`
      // status, not a 404: the query came back empty (no text fallback either).
      vi.spyOn(lspApi, "getReferences").mockResolvedValue({
        references: [],
        hasMore: false,
        cursor: null,
      });
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
        status: "not_found",
        language: "rust",
        displayName: "Rust",
        label: "Unavailable",
        severity: "neutral",
        detail: "No language server installed for Rust",
        action: null,
        actionLabel: null,
      });

      useWorkspaceStore.getState().setPendingReferencesQuery({
        worktreeId: W1,
        path: "/src/main.rs",
        line: 10,
        character: 4,
        symbol: "not_found_sym",
      });

      render(<ReferencesPanel api={{}} worktreeId={W1} />);

      expect(await screen.findByText("No Rust language server on this host.")).toBeInTheDocument();
      expect(chipWord()).toBe("No server");
      expect(screen.getByText("No language server installed for Rust")).toBeInTheDocument();
    });

    it("maps a 404 to 'File or workspace not found', not the missing-server banner", async () => {
      vi.spyOn(lspApi, "getReferences").mockRejectedValue(
        new ApiError(JSON.stringify({ error: "Worktree 'wt-1' not found", code: "NOT_FOUND" }), 404)
      );

      useWorkspaceStore.getState().setPendingReferencesQuery({
        worktreeId: W1,
        path: "/src/main.rs",
        line: 10,
        character: 4,
        symbol: "missing_sym",
      });

      render(<ReferencesPanel api={{}} worktreeId={W1} />);

      expect(await screen.findByText("File or workspace not found", { selector: "pre" })).toBeInTheDocument();
      expect(screen.queryByText(/language server on this host/)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    });

    it("maps a 404 LSP_EXTERNAL_TOKEN_EXPIRED to a token-expired error", async () => {
      vi.spyOn(lspApi, "getReferences").mockRejectedValue(
        new ApiError(JSON.stringify({ error: "External token expired", code: "LSP_EXTERNAL_TOKEN_EXPIRED" }), 404)
      );

      useWorkspaceStore.getState().setPendingReferencesQuery({
        worktreeId: W1,
        path: "/src/main.rs",
        line: 10,
        character: 4,
        symbol: "expired_sym",
      });

      render(<ReferencesPanel api={{}} worktreeId={W1} />);

      expect(await screen.findByText(/External token expired/)).toBeInTheDocument();
    });

    it("renders 'Language server error.' and the header Refresh re-runs the query", async () => {
      const getRefs = vi.spyOn(lspApi, "getReferences").mockRejectedValue(
        new Error("Server crashed")
      );

      useWorkspaceStore.getState().setPendingReferencesQuery({
        worktreeId: W1,
        path: "/src/main.rs",
        line: 10,
        character: 4,
        symbol: "err_sym",
      });

      render(<ReferencesPanel api={{}} worktreeId={W1} />);

      expect(await screen.findByText("Server crashed", { selector: "pre" })).toBeInTheDocument();
      const refreshBtn = screen.getByRole("button", { name: "Refresh" });

      fireEvent.click(refreshBtn);
      expect(getRefs).toHaveBeenCalledTimes(2);
    });

    it("S12: text-only results show one slim hint row + Text chip, no per-row badges", async () => {
      vi.spyOn(lspApi, "getReferences").mockResolvedValue({
        references: [
          {
            path: "/src/main.rs",
            external: false,
            token: null,
            displayPath: null,
            entries: [
              { line: 5, character: 2, preview: "foo();", isDeclaration: false, confidence: "text" },
            ],
          },
        ],
        hasMore: false,
        cursor: null,
      });
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
        status: "disabled",
        language: "rust",
        displayName: "Rust",
        label: "Disabled",
        severity: "neutral",
        detail: "Code navigation is disabled",
        action: "enable",
        actionLabel: "Enable",
      });

      useWorkspaceStore.getState().setPendingReferencesQuery({
        worktreeId: W1,
        path: "/src/main.rs",
        line: 5,
        character: 2,
        symbol: "foo",
      });

      const { container } = render(<ReferencesPanel api={{}} worktreeId={W1} />);

      expect(await screen.findByText("Text matches · Code navigation is off")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument();
      expect(chipWord()).toBe("Text");
      expect(screen.queryByText("text")).not.toBeInTheDocument();
      const preview = container.querySelector(".references-panel__preview");
      expect(preview?.textContent).toBe("foo();");
    });
  });

  describe("Bug 3 — preview windowing and match highlighting", () => {
    it("renders matched symbol in <mark class='references-panel__match'> inside preview", async () => {
      vi.spyOn(lspApi, "getReferences").mockResolvedValue({
        references: [
          {
            path: "/src/main.rs",
            external: false,
            token: null,
            displayPath: null,
            entries: [
              {
                line: 10,
                character: 4,
                preview: "    my_special_func(); // call here",
                isDeclaration: false,
                confidence: "lsp",
              },
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
        symbol: "my_special_func",
      });

      const { container } = render(<ReferencesPanel api={{}} worktreeId={W1} />);

      await waitFor(() => {
        const mark = container.querySelector("mark.references-panel__match");
        expect(mark).toBeInTheDocument();
        expect(mark?.textContent).toBe("my_special_func");
      });
    });

    it("highlights the occurrence at entry.character, not the first indexOf", async () => {
      vi.spyOn(lspApi, "getReferences").mockResolvedValue({
        references: [
          {
            path: "/src/main.rs",
            external: false,
            token: null,
            displayPath: null,
            entries: [
              {
                line: 10,
                // Second `makeGreeter` call on the line.
                character: 18,
                preview: 'makeGreeter("a"), makeGreeter("b")',
                isDeclaration: false,
                confidence: "lsp",
              },
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
        character: 18,
        symbol: "makeGreeter",
      });

      const { container } = render(<ReferencesPanel api={{}} worktreeId={W1} />);

      await waitFor(() => {
        const marks = container.querySelectorAll("mark.references-panel__match");
        expect(marks).toHaveLength(1);
        expect(marks[0]?.textContent).toBe("makeGreeter");
      });

      // The mark sits at offset 18 (the second call), not 0 (the first) —
      // walk the text nodes preceding it, robust to Shiki span splitting.
      const mark = container.querySelector("mark.references-panel__match");
      let offset = 0;
      for (let node = mark?.previousSibling; node; node = node.previousSibling) {
        offset += node.textContent?.length ?? 0;
      }
      expect(offset).toBe(18);
    });

    it("retries LSP_NOT_READY with backoff and then renders the result", async () => {
      const notReady = () =>
        new ApiError(JSON.stringify({ error: "Language server still starting", code: "LSP_NOT_READY" }), 409);
      const getRefs = vi
        .spyOn(lspApi, "getReferences")
        .mockRejectedValueOnce(notReady())
        .mockRejectedValueOnce(notReady())
        .mockResolvedValue({
          references: [
            {
              path: "/src/main.rs",
              external: false,
              token: null,
              displayPath: null,
              entries: [
                { line: 3, character: 2, preview: "run();", isDeclaration: false, confidence: "lsp" },
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

      // Initial attempt + 2 backoff retries (500ms + 1000ms).
      await expectResults("run", "1", 5000);
      expect(getRefs).toHaveBeenCalledTimes(3);
    });

    it("S4: exhausts the LSP_NOT_READY retry loop (status not starting) and offers Refresh", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const getRefs = vi.spyOn(lspApi, "getReferences").mockRejectedValue(
          new ApiError(JSON.stringify({ error: "Language server still starting", code: "LSP_NOT_READY" }), 409)
        );

        useWorkspaceStore.getState().setPendingReferencesQuery({
          worktreeId: W1,
          path: "/src/main.rs",
          line: 10,
          character: 4,
          symbol: "starting_sym",
        });

        render(<ReferencesPanel api={{}} worktreeId={W1} />);

        // Initial attempt + 4 backoff retries (500+1000+2000+2000ms).
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6000);
        });

        expect(getRefs).toHaveBeenCalledTimes(5);
        expect(screen.getByText("Language server starting…")).toBeInTheDocument();
        expect(chipWord()).toBe("Starting");
        expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("discards a superseded query's late result", async () => {
      // A slow first query is superseded by a fresh one; when the slow
      // response finally lands it must not overwrite the current results.
      let resolveFirst!: (value: lspApi.LspReferencesResponse) => void;
      const getRefs = vi
        .spyOn(lspApi, "getReferences")
        .mockImplementationOnce(
          () =>
            new Promise<lspApi.LspReferencesResponse>((resolve) => {
              resolveFirst = resolve;
            })
        )
        .mockResolvedValueOnce({
          references: [
            {
              path: "/src/main.rs",
              external: false,
              token: null,
              displayPath: null,
              entries: [
                { line: 7, character: 2, preview: "second();", isDeclaration: false, confidence: "lsp" },
              ],
            },
          ],
          hasMore: false,
          cursor: null,
        });
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
        status: "ready",
        language: "rust",
        displayName: "Rust",
        label: "Ready",
        severity: "ok",
        detail: "LSP: ready",
        action: null,
        actionLabel: null,
      });

      useWorkspaceStore.getState().setPendingReferencesQuery({
        worktreeId: W1,
        path: "/src/main.rs",
        line: 10,
        character: 4,
        symbol: "first",
      });

      render(<ReferencesPanel api={{}} worktreeId={W1} />);

      // Second query supersedes the first while it is still in flight.
      await waitFor(() => expect(getRefs).toHaveBeenCalledTimes(1));
      useWorkspaceStore.getState().setPendingReferencesQuery({
        worktreeId: W1,
        path: "/src/main.rs",
        line: 20,
        character: 4,
        symbol: "second",
      });

      await expectResults("second", "1");

      // The slow first query resolves late — its result must be discarded.
      await act(async () => {
        resolveFirst({
          references: [
            {
              path: "/src/main.rs",
              external: false,
              token: null,
              displayPath: null,
              entries: [
                { line: 1, character: 2, preview: "first();", isDeclaration: false, confidence: "lsp" },
              ],
            },
          ],
          hasMore: false,
          cursor: null,
        });
      });

      expect(headerTitle()).toBe("second");
      expect(countPill()).toBe("1");
      // Exactly one row remains, showing the second query's preview (the
      // preview text may be split into Shiki spans once highlighted, so
      // assert on textContent rather than a plain-text match).
      expect(document.querySelectorAll(".references-panel__row")).toHaveLength(1);
      expect(document.querySelector(".references-panel__preview")?.textContent).toBe("second();");
    });
  });

  describe("Bug 11 — ReferencesPanel state machine extensions", () => {
    it("renders 'No language server for this file type' when 422 LSP_UNSUPPORTED occurs", async () => {
      vi.spyOn(lspApi, "getReferences").mockRejectedValue(
        new ApiError(JSON.stringify({ error: "LSP operation unsupported", code: "LSP_UNSUPPORTED" }), 422)
      );

      useWorkspaceStore.getState().setPendingReferencesQuery({
        worktreeId: W1,
        path: "/src/notes.txt",
        line: 0,
        character: 0,
        symbol: "unsupported_sym",
      });

      render(<ReferencesPanel api={{}} worktreeId={W1} />);

      expect(await screen.findByText("No code navigation for this file type.")).toBeInTheDocument();
      expect(chipWord()).toBe("N/A");
    });

    it("renders 'No references to sym' (never a definition sentence) on genuine zero results", async () => {
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
        symbol: "zero_sym",
      });

      render(<ReferencesPanel api={{}} worktreeId={W1} />);

      expect(await screen.findByText(/No references to/)).toBeInTheDocument();
      expect(screen.queryByText(/definition/i)).not.toBeInTheDocument();
    });

    it("S1→S2: Searching shows skeleton + Cancel; Cancel reports 'Search cancelled', not zero results", async () => {
      let resolvePromise: (value: unknown) => void;
      const pendingPromise = new Promise((resolve) => {
        resolvePromise = resolve;
      });
      vi.spyOn(lspApi, "getReferences").mockReturnValue(pendingPromise as never);

      useWorkspaceStore.getState().setPendingReferencesQuery({
        worktreeId: W1,
        path: "/src/main.rs",
        line: 10,
        character: 4,
        symbol: "resolving_sym",
      });

      render(<ReferencesPanel api={{}} worktreeId={W1} />);

      expect(screen.getByRole("status", { name: "Searching references" })).toBeInTheDocument();
      expect(chipWord()).toBe("Searching");
      const cancelBtn = screen.getByRole("button", { name: "Cancel" });

      fireEvent.click(cancelBtn);
      expect(screen.getByText("Search cancelled.")).toBeInTheDocument();
      expect(chipWord()).toBe("Cancelled");
      await act(async () => {
        resolvePromise!({ references: [], hasMore: false, cursor: null });
      });
      // The late response is discarded — still cancelled, never "No references".
      expect(screen.getByText("Search cancelled.")).toBeInTheDocument();
      expect(screen.queryByText(/No references/)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    });
  });

  describe("Round 2 — state catalog (Bug 1 / Bug 5)", () => {
    const status = (over: Partial<lspApi.LspStatusResponse>): lspApi.LspStatusResponse => ({
      status: "ready",
      language: "rust",
      displayName: "Rust",
      label: "Ready",
      severity: "ok",
      detail: "LSP: ready",
      action: null,
      actionLabel: null,
      ...over,
    });
    const oneRow = (line: number, preview = "run();"): lspApi.LspReferencesResponse => ({
      references: [
        {
          path: "/src/main.rs",
          external: false,
          token: null,
          displayPath: null,
          entries: [{ line, character: 0, preview, isDeclaration: false, confidence: "lsp" }],
        },
      ],
      hasMore: true,
      cursor: "c1",
    });

    it("S16: a no-definition query does NOT fetch references; shows the degraded reason + Text search", async () => {
      const getRefs = vi.spyOn(lspApi, "getReferences");
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(
        status({ degraded: { message: "Failed to read Cargo metadata with dependencies" } }),
      );
      useWorkspaceStore.getState().setPendingReferencesQuery({
        worktreeId: W1,
        path: "/src/network.rs",
        line: 28,
        character: 15,
        symbol: "oneshot",
        intent: "no-definition",
      });

      render(<ReferencesPanel api={{}} worktreeId={W1} />);

      expect(await screen.findByText(/resolve/)).toBeInTheDocument();
      expect(screen.getByText("oneshot", { selector: "code" })).toBeInTheDocument();
      await waitFor(() => expect(screen.getByText(/Failed to read Cargo metadata/)).toBeInTheDocument());
      expect(chipWord()).toBe("Partial");
      expect(getRefs).not.toHaveBeenCalled();
      expect(screen.queryByText(/No references/)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Text search" }));
      const st = useWorkspaceStore.getState();
      expect(st.filesLeftPaneMode[W1]).toBe("search");
      expect(st.pendingTextSearch).toEqual({ contextId: W1, text: "oneshot" });
    });

    it("S16: 'Find references' from the no-definition state runs a references query", async () => {
      const getRefs = vi.spyOn(lspApi, "getReferences").mockResolvedValue(oneRow(3));
      useWorkspaceStore.getState().setPendingReferencesQuery({
        worktreeId: W1,
        path: "/src/main.rs",
        line: 1,
        character: 0,
        symbol: "run",
        intent: "no-definition",
      });
      render(<ReferencesPanel api={{}} worktreeId={W1} />);
      fireEvent.click(await screen.findByRole("button", { name: "Find references" }));
      await expectResults("run", "1+");
      expect(getRefs).toHaveBeenCalledTimes(1);
    });

    it("S13: 'Loading more' never touches the chip (no 'indexing')", async () => {
      let resolveMore!: (v: lspApi.LspReferencesResponse) => void;
      vi.spyOn(lspApi, "getReferences")
        .mockResolvedValueOnce(oneRow(3))
        .mockImplementationOnce(() => new Promise((r) => { resolveMore = r; }));
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(status({}));
      useWorkspaceStore.getState().setPendingReferencesQuery({
        worktreeId: W1, path: "/src/main.rs", line: 1, character: 0, symbol: "run",
      });
      render(<ReferencesPanel api={{}} worktreeId={W1} />);
      await expectResults("run", "1+");
      await waitFor(() => expect(chipWord()).toBe("LSP"));

      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
      expect(await screen.findByText("Loading more…")).toBeInTheDocument();
      expect(chipWord()).toBe("LSP");
      expect(screen.queryByText(/index/i)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

      await act(async () => {
        resolveMore({ ...oneRow(9, "run(2);"), hasMore: false, cursor: null });
      });
      await expectResults("run", "2");
    });

    it("S13: a 'Show more' page without a fallback keeps the first page's text-fallback chip", async () => {
      vi.spyOn(lspApi, "getReferences")
        .mockResolvedValueOnce({ ...oneRow(3), fallback: { reason: "starting" } })
        .mockResolvedValueOnce({ ...oneRow(9, "run(2);"), hasMore: false, cursor: null });
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(status({}));
      useWorkspaceStore.getState().setPendingReferencesQuery({
        worktreeId: W1, path: "/src/main.rs", line: 1, character: 0, symbol: "run",
      });
      render(<ReferencesPanel api={{}} worktreeId={W1} />);
      await expectResults("run", "1+");
      await waitFor(() => expect(chipWord()).toBe("Text"));

      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
      await expectResults("run", "2");
      expect(chipWord()).toBe("Text");
    });

    it("S15: degraded server marks results Partial with a slim 'may be incomplete' hint", async () => {
      vi.spyOn(lspApi, "getReferences").mockResolvedValue({ ...oneRow(3), hasMore: false });
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(
        status({ degraded: { message: "cargo metadata failed" } }),
      );
      useWorkspaceStore.getState().setPendingReferencesQuery({
        worktreeId: W1, path: "/src/main.rs", line: 1, character: 0, symbol: "run",
      });
      render(<ReferencesPanel api={{}} worktreeId={W1} />);
      expect(await screen.findByText("Results may be incomplete")).toBeInTheDocument();
      expect(chipWord()).toBe("Partial");
    });

    it("S3: keeps auto-retrying past 5 attempts while the status poll says starting", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const notReady = () =>
          new ApiError(JSON.stringify({ error: "starting", code: "LSP_NOT_READY" }), 409);
        const getRefs = vi.spyOn(lspApi, "getReferences");
        for (let i = 0; i < 6; i++) getRefs.mockRejectedValueOnce(notReady());
        getRefs.mockResolvedValue({ ...oneRow(3), hasMore: false });
        vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(status({ status: "starting", label: "Starting" }));

        useWorkspaceStore.getState().setPendingReferencesQuery({
          worktreeId: W1, path: "/src/main.rs", line: 1, character: 0, symbol: "run",
        });
        render(<ReferencesPanel api={{}} worktreeId={W1} />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1600);
        });
        expect(chipWord()).toBe("Starting");
        await act(async () => {
          await vi.advanceTimersByTimeAsync(12000);
        });
        expect(getRefs).toHaveBeenCalledTimes(7);
        expect(headerTitle()).toBe("run");
        expect(countPill()).toBe("1");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("S17 — language server failed to start", () => {
    const command = 'npm i -D "typescript@<7"';
    const failure: lspApi.LspFailure = {
      kind: "missing_dependency",
      summary: "TypeScript isn't installed for this project — code navigation needs it.",
      message: "Request initialize failed with message: Could not find a valid TypeScript installation.",
      remediation: [
        { kind: "copy_command", label: "Copy install command", command },
        { kind: "retry", label: "Retry" },
      ],
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
    const query = { worktreeId: W1, path: "src/a.ts", line: 3, character: 4, symbol: "useStore" };
    const failed503 = () =>
      new ApiError(JSON.stringify({ error: failure.summary, code: "LSP_SERVER_FAILED", failure }), 503);

    it("a 503 renders S17 (Setup chip, title, command, remediation, Server output) — never 'process died'", async () => {
      vi.spyOn(lspApi, "getReferences").mockRejectedValue(failed503());
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(failedStatus);
      useWorkspaceStore.getState().setPendingReferencesQuery(query);
      render(<ReferencesPanel api={{}} worktreeId={W1} />);

      expect(await screen.findByText("TypeScript / JavaScript code navigation is unavailable.")).toBeInTheDocument();
      expect(chipWord()).toBe("Setup");
      expect(screen.getByText(failure.summary)).toBeInTheDocument();
      expect(screen.getByText(command, { selector: "code" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Copy install command" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
      expect(screen.getByText("Server output")).toBeInTheDocument();
      expect(screen.queryByText(/process died/i)).not.toBeInTheDocument();
      expect(screen.queryByText("Language server error.")).not.toBeInTheDocument();
    });

    it("a non-dependency failure is an Error chip", async () => {
      const initFailed: lspApi.LspFailure = {
        ...failure,
        kind: "init_failed",
        summary: "typescript-language-server failed to start: boom",
        remediation: [{ kind: "retry", label: "Retry" }],
      };
      vi.spyOn(lspApi, "getReferences").mockRejectedValue(
        new ApiError(JSON.stringify({ error: "x", code: "LSP_SERVER_FAILED", failure: initFailed }), 503),
      );
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({ ...failedStatus, failure: initFailed, label: "Error" });
      useWorkspaceStore.getState().setPendingReferencesQuery(query);
      render(<ReferencesPanel api={{}} worktreeId={W1} />);
      expect(await screen.findByText("TypeScript / JavaScript code navigation is unavailable.")).toBeInTheDocument();
      expect(chipWord()).toBe("Error");
      expect(screen.queryByRole("button", { name: "Copy install command" })).not.toBeInTheDocument();
    });

    it("Retry respawns the server (restart route) then re-runs the query", async () => {
      const getRefs = vi.spyOn(lspApi, "getReferences").mockRejectedValueOnce(failed503()).mockResolvedValue({
        references: [],
        hasMore: false,
        cursor: null,
      });
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(failedStatus);
      const restart = vi.spyOn(lspApi, "restartLsp").mockResolvedValue({ ...failedStatus, status: "starting" });
      useWorkspaceStore.getState().setPendingReferencesQuery(query);
      render(<ReferencesPanel api={{}} worktreeId={W1} />);
      await screen.findByText("TypeScript / JavaScript code navigation is unavailable.");
      // Wait for the poll so the hook knows the server's language.
      await waitFor(() => expect(lspApi.getLspStatus).toHaveBeenCalled());
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(restart).toHaveBeenCalledWith({}, "worktree", W1, "typescript"));
      await waitFor(() => expect(getRefs).toHaveBeenCalledTimes(2));
    });

    it("text fallback with hits shows the 'Text matches only' banner with remediation", async () => {
      vi.spyOn(lspApi, "getReferences").mockResolvedValue({
        references: [
          {
            path: "src/a.ts",
            external: false,
            token: null,
            displayPath: null,
            entries: [{ line: 3, character: 4, preview: "    useStore();", isDeclaration: false, confidence: "text" }],
          },
        ],
        hasMore: false,
        cursor: null,
        fallback: { reason: "server_failed" },
      });
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(failedStatus);
      useWorkspaceStore.getState().setPendingReferencesQuery(query);
      render(<ReferencesPanel api={{}} worktreeId={W1} />);
      expect(
        await screen.findByText("Text matches only — TypeScript isn't installed for this project."),
      ).toBeInTheDocument();
      expect(chipWord()).toBe("Text");
      expect(screen.getByRole("button", { name: "Copy install command" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    });

    it("text fallback with 0 hits: 'No text matches' + failure hint + remediation", async () => {
      vi.spyOn(lspApi, "getReferences").mockResolvedValue({
        references: [],
        hasMore: false,
        cursor: null,
        fallback: { reason: "server_failed" },
      });
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(failedStatus);
      useWorkspaceStore.getState().setPendingReferencesQuery(query);
      render(<ReferencesPanel api={{}} worktreeId={W1} />);
      await waitFor(() => expect(screen.getByText(failure.summary)).toBeInTheDocument());
      expect(document.querySelector(".references-panel__state-title")?.textContent).toBe("No text matches for useStore.");
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    });

    it("a no-definition query carrying the failure opens straight in S17 without fetching", async () => {
      const getRefs = vi.spyOn(lspApi, "getReferences");
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(failedStatus);
      useWorkspaceStore.getState().setPendingReferencesQuery({ ...query, intent: "no-definition", failure });
      render(<ReferencesPanel api={{}} worktreeId={W1} />);
      expect(await screen.findByText("TypeScript / JavaScript code navigation is unavailable.")).toBeInTheDocument();
      expect(screen.queryByText(/found no definition/)).not.toBeInTheDocument();
      expect(getRefs).not.toHaveBeenCalled();
    });
  });

  it("U8: an info-level degraded note (fallback TypeScript) never turns the chip Partial", async () => {
    vi.spyOn(lspApi, "getReferences").mockResolvedValue({
      references: [
        {
          path: "src/a.ts",
          external: false,
          token: null,
          displayPath: null,
          entries: [{ line: 3, character: 4, preview: "useStore();", isDeclaration: false, confidence: "lsp" }],
        },
      ],
      hasMore: false,
      cursor: null,
    });
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
      status: "ready",
      language: "typescript",
      displayName: "TypeScript / JavaScript",
      label: "Ready",
      severity: "ok",
      detail: "LSP: ready",
      action: null,
      actionLabel: null,
      degraded: { message: "Using TypeScript 5.9.3 (global) — workspace TypeScript 7.0.2 has no tsserver.", level: "info" },
    });
    useWorkspaceStore.getState().setPendingReferencesQuery({
      worktreeId: W1, path: "src/a.ts", line: 3, character: 4, symbol: "useStore",
    });
    render(<ReferencesPanel api={{}} worktreeId={W1} />);
    await expectResults("useStore", "1");
    await waitFor(() => expect(lspApi.getLspStatus).toHaveBeenCalled());
    expect(chipWord()).toBe("LSP");
    expect(screen.queryByText("Results may be incomplete")).not.toBeInTheDocument();
  });
});
