import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SearchResult } from "@/api/types";
import type { ApiInstance } from "@/api";
import { ApiError } from "@/api/errors";
import { SearchPanel } from "./SearchPanel";

type MockSearchApi = ApiInstance & { search: ReturnType<typeof vi.fn> };

// Mock store
const mockSetActiveFilePathAtLine = vi.fn();
const mockOpenFileTabNew = vi.fn();
const mockSetToolPanelTab = vi.fn();
const mockSetPeekFile = vi.fn();
const mockPushJump = vi.fn((arg: { worktreeId: string; path: string; line: number; matchText: string | null; source?: string; coalesce?: boolean }) => {
  mockSetPeekFile({ worktreeId: arg.worktreeId, path: arg.path, line: arg.line, matchText: arg.matchText });
});
const mockClearPeekFile = vi.fn();
// Module-level mutable store state so tests can drive `filesLeftPaneMode` /
// `searchFocusSeq` (Phase 3.7/3.7a) and re-render to observe the focus effects.
const mockStoreState: Record<string, unknown> = {
  setActiveFilePathAtLine: mockSetActiveFilePathAtLine,
  openFileTabNew: mockOpenFileTabNew,
  setToolPanelTab: mockSetToolPanelTab,
  setPeekFile: mockSetPeekFile,
  pushJump: mockPushJump,
  clearPeekFile: mockClearPeekFile,
  filesLeftPaneMode: {} as Record<string, "tree" | "search">,
  searchFocusSeq: {} as Record<string, number>,
  layoutByWorktree: {} as Record<string, unknown>,
};
vi.mock("@/hooks/useStore", () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) => selector(mockStoreState),
  DEFAULT_WORKTREE_LAYOUT: { masterDetailVertical: false },
}));

describe("SearchPanel", () => {
  let mockApi: MockSearchApi;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreState.filesLeftPaneMode = {};
    mockStoreState.searchFocusSeq = {};
    mockApi = {
      search: vi.fn(),
      getSettings: vi.fn().mockResolvedValue({ defaultProjectsDir: "/tmp" }),
      updateSettings: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as MockSearchApi;
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  // ── 3.T1: Unit test for debounce ──
  describe("3.T1: Debounce", () => {
    it("debounces API calls at 200ms", async () => {
      mockApi.search.mockResolvedValue({ files: [], truncated: false, totalMatches: 0 });

      render(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);

      const input = screen.getByPlaceholderText("Search content...");

      // Type characters rapidly
      await userEvent.type(input, "test", { delay: 50 });

      // Should not have called API yet (still within debounce window)
      expect(mockApi.search).not.toHaveBeenCalled();

      // Wait for debounce
      vi.useFakeTimers();
      vi.advanceTimersByTime(200);
      vi.useRealTimers();

      await waitFor(() => {
        expect(mockApi.search).toHaveBeenCalledOnce();
      });
    });

    it("does not call API when query is empty", async () => {
      render(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);

      const input = screen.getByPlaceholderText("Search content...");

      // Clear input (or start empty)
      await userEvent.clear(input);

      vi.useFakeTimers();
      vi.advanceTimersByTime(200);
      vi.useRealTimers();

      expect(mockApi.search).not.toHaveBeenCalled();
    });
  });

  // Live-review feedback — a clear button overlaid on the query input.
  describe("Clear-search button", () => {
    it("is absent when the query is empty, appears once text is typed, and clears+refocuses on click", async () => {
      const user = userEvent.setup();
      mockApi.search.mockResolvedValue({ files: [], truncated: false, totalMatches: 0 });
      render(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);
      const input = screen.getByPlaceholderText("Search content...");

      expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();

      await user.type(input, "test");
      const clearBtn = screen.getByRole("button", { name: "Clear search" });
      expect(clearBtn).toBeInTheDocument();

      await user.click(clearBtn);
      expect(input).toHaveValue("");
      expect(document.activeElement).toBe(input);
      expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
    });
  });

  // ── 3.T2: Unit test for grouping ──
  describe("3.T2: Result grouping", () => {
    it("renders one collapsible group per distinct file path", async () => {
      const results: SearchResult = {
        files: [
          {
            path: "src/App.tsx",
            matches: [
              { line: 10, pre: "const ", mid: "App", post: " = () => {" },
              { line: 15, pre: "  return ", mid: "App", post: "();" },
            ],
          },
          {
            path: "src/main.tsx",
            matches: [
              { line: 5, pre: "import ", mid: "App", post: " from './App'" },
            ],
          },
        ],
        truncated: false,
        totalMatches: 3,
      };

      mockApi.search.mockResolvedValue(results);

      render(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);

      const input = screen.getByPlaceholderText("Search content...");
      await userEvent.type(input, "App");

      vi.useFakeTimers();
      vi.advanceTimersByTime(200);
      vi.useRealTimers();

      await waitFor(() => {
        expect(screen.getByText("src/App.tsx")).toBeInTheDocument();
        expect(screen.getByText("src/main.tsx")).toBeInTheDocument();
      });

      // Check match counts
      expect(screen.getByText("2 matches")).toBeInTheDocument();
      expect(screen.getByText("1 match")).toBeInTheDocument();
    });
  });

  // ── 3.T3: Integration test for clicking results ──
  describe("3.T3: Click result row", () => {
    // Live-review feedback: a plain click no longer commits — it only moves
    // the roving cursor there via the row's native focus event (same as
    // arrow-key nav), which drives the peek. Committing is now Enter-only
    // (or Ctrl/Cmd-click / Mod+Enter for "open in a new tab").
    it("plain click does NOT commit — it only updates cursorPath (peek), same as arrow-key nav", async () => {
      const results: SearchResult = {
        files: [
          {
            path: "src/test.tsx",
            matches: [
              { line: 42, pre: "function ", mid: "test", post: "() {}" },
            ],
          },
        ],
        truncated: false,
        totalMatches: 1,
      };

      mockApi.search.mockResolvedValue(results);

      render(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);

      const input = screen.getByPlaceholderText("Search content...");
      await userEvent.type(input, "test");

      vi.useFakeTimers();
      vi.advanceTimersByTime(200);
      vi.useRealTimers();

      await waitFor(() => {
        expect(screen.getByText("src/test.tsx")).toBeInTheDocument();
      });

      // Click the match row
      const matchButtons = screen.getAllByRole("button");
      const matchRow = matchButtons.find((btn) => btn.textContent?.includes("42"));
      expect(matchRow).toBeDefined();

      // Fake timers active BEFORE the click/focus so the peek debounce's own
      // setTimeout is one `advanceTimersByTime` can actually control.
      vi.useFakeTimers();
      fireEvent.click(matchRow!);
      fireEvent.focus(matchRow!); // native focus-on-click, jsdom doesn't fire it for us

      expect(mockSetActiveFilePathAtLine).not.toHaveBeenCalled();
      expect(mockSetToolPanelTab).not.toHaveBeenCalled();

      // The peek debounce (200ms) then fires from the cursor move.
      vi.advanceTimersByTime(200);
      vi.useRealTimers();
      expect(mockSetPeekFile).toHaveBeenCalledWith({ worktreeId: "wt-1", path: "src/test.tsx", line: 42, matchText: "test" });
    });

    it("Ctrl/Cmd-click still commits straight to a NEW tab", async () => {
      const results: SearchResult = {
        files: [
          {
            path: "src/test.tsx",
            matches: [{ line: 42, pre: "function ", mid: "test", post: "() {}" }],
          },
        ],
        truncated: false,
        totalMatches: 1,
      };
      mockApi.search.mockResolvedValue(results);
      render(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);
      const input = screen.getByPlaceholderText("Search content...");
      await userEvent.type(input, "test");
      vi.useFakeTimers();
      vi.advanceTimersByTime(200);
      vi.useRealTimers();
      await waitFor(() => expect(screen.getByText("src/test.tsx")).toBeInTheDocument());

      const matchRow = screen.getAllByRole("button").find((btn) => btn.textContent?.includes("42"))!;
      fireEvent.click(matchRow, { ctrlKey: true });

      expect(mockOpenFileTabNew).toHaveBeenCalledWith("wt-1", "src/test.tsx");
      expect(mockSetActiveFilePathAtLine).toHaveBeenCalledWith("wt-1", "src/test.tsx", 42, "test");
      expect(mockSetToolPanelTab).toHaveBeenCalledWith("files");
    });
  });

  // 3.T4 lives in FilePreviewPane.test.tsx — it needs a real rendered
  // FilePreviewPane to exercise the actual scroll effect, not a detached
  // DOM node built here (a prior version of this test did that and asserted
  // nothing meaningful — see that file's "3.T4" describe block instead).

  // ── 3.T12: Error handling for ripgrep not found ──
  describe("Error handling", () => {
    it("shows banner for 503 ripgrep not found error", async () => {
      mockApi.search.mockRejectedValue(new ApiError("ripgrep not available", 503));

      render(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);

      const input = screen.getByPlaceholderText("Search content...");
      await userEvent.type(input, "test");

      vi.useFakeTimers();
      vi.advanceTimersByTime(200);
      vi.useRealTimers();

      await waitFor(() => {
        expect(
          screen.getByText("ripgrep not found — content search unavailable"),
        ).toBeInTheDocument();
      });
    });

    it("shows generic error message for other errors", async () => {
      mockApi.search.mockRejectedValue(new Error("Network error"));

      render(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);

      const input = screen.getByPlaceholderText("Search content...");
      await userEvent.type(input, "test");

      vi.useFakeTimers();
      vi.advanceTimersByTime(200);
      vi.useRealTimers();

      await waitFor(() => {
        expect(screen.getByText("Network error")).toBeInTheDocument();
      });
    });
  });

  // ── Phase 1: roving-nav keyboard navigation ──
  describe("Roving nav keyboard navigation", () => {
    const navResults: SearchResult = {
      files: [
        {
          path: "src/a.ts",
          matches: [
            { line: 1, pre: "const ", mid: "A", post: " = 1" },
            { line: 2, pre: "const ", mid: "A", post: " = 2" },
          ],
        },
        {
          path: "src/b.ts",
          matches: [{ line: 5, pre: "const ", mid: "B", post: " = 5" }],
        },
      ],
      truncated: false,
      totalMatches: 3,
    };

    async function renderWithResults() {
      mockApi.search.mockResolvedValue(navResults);
      render(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);
      const input = screen.getByPlaceholderText("Search content...");
      await userEvent.type(input, "test");
      vi.useFakeTimers();
      vi.advanceTimersByTime(200);
      vi.useRealTimers();
      await waitFor(() => {
        expect(screen.getByText("src/a.ts")).toBeInTheDocument();
      });
      const container = document.querySelector(
        ".search-panel__results-list",
      ) as HTMLElement;
      return { input, container };
    }

    // 1.T1 — Enter from input seeds cursor to first row + moves DOM focus
    it("Enter in query input with results seeds cursor to first row and moves DOM focus there", async () => {
      const { input } = await renderWithResults();
      fireEvent.keyDown(input, { key: "Enter" });
      // First row is the src/a.ts header; focus moves to it.
      expect(document.activeElement).toHaveClass("search-panel__file-header");
      expect(document.activeElement).toHaveTextContent("src/a.ts");
    });

    // Live-review fix — ArrowDown/ArrowUp from the query input seed the
    // cursor and move focus into results immediately, same as Enter, so
    // arrow-key nav works right away without requiring Enter first.
    it("ArrowDown in query input with results seeds cursor to first row and moves DOM focus there, without pressing Enter first", async () => {
      const { input } = await renderWithResults();
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(document.activeElement).toHaveClass("search-panel__file-header");
      expect(document.activeElement).toHaveTextContent("src/a.ts");
    });

    it("ArrowUp in query input with results also seeds cursor to first row and moves DOM focus there", async () => {
      const { input } = await renderWithResults();
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(document.activeElement).toHaveClass("search-panel__file-header");
      expect(document.activeElement).toHaveTextContent("src/a.ts");
    });

    // 1.T1/S2 — Enter while debounce pending flushes synchronously
    it("Enter while the debounce is still pending flushes the search synchronously", async () => {
      mockApi.search.mockResolvedValue({ files: [], truncated: false, totalMatches: 0 });
      render(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);
      const input = screen.getByPlaceholderText("Search content...");
      await userEvent.type(input, "test");
      mockApi.search.mockClear();
      // Debounce timer is still pending (no advance). Enter should flush it now.
      fireEvent.keyDown(input, { key: "Enter" });
      expect(mockApi.search).toHaveBeenCalledTimes(1);
    });

    // S-2 — the Enter debounce-flush must seed the cursor from the FRESH
    // results (the ones the flushed search returns), NOT the stale pre-flush
    // rows (a plain `matchRows[0]` read right after the async flush is stale).
    it("S-2 — Enter flush seeds the cursor from the fresh results, not the stale pre-flush rows", async () => {
      const staleResults: SearchResult = {
        files: [{ path: "src/stale.ts", matches: [{ line: 9, pre: "", mid: "OLD", post: "" }] }],
        truncated: false,
        totalMatches: 1,
      };
      const freshResults: SearchResult = {
        files: [{ path: "src/fresh.ts", matches: [{ line: 77, pre: "", mid: "NEW", post: "" }] }],
        truncated: false,
        totalMatches: 1,
      };
      // First search (query "old") -> stale; the Enter flush (query "new") -> fresh.
      mockApi.search
        .mockResolvedValueOnce(staleResults)
        .mockResolvedValueOnce(freshResults);

      render(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);
      const input = screen.getByPlaceholderText("Search content...");

      // Produce the STALE results first.
      fireEvent.change(input, { target: { value: "old" } });
      vi.useFakeTimers();
      vi.advanceTimersByTime(200);
      vi.useRealTimers();
      await waitFor(() => expect(screen.getByText("src/stale.ts")).toBeInTheDocument());

      // New query, debounce still PENDING (do not advance). Enter flushes it.
      vi.useFakeTimers();
      fireEvent.change(input, { target: { value: "new" } });
      fireEvent.keyDown(input, { key: "Enter" });
      vi.useRealTimers();

      // The flushed search resolved with FRESH results — the cursor + DOM focus
      // must land on fresh.ts's first row (the fresh.ts header), NOT the stale
      // stale.ts header that matchRows still held synchronously after the flush.
      await waitFor(() => expect(screen.getByText("src/fresh.ts")).toBeInTheDocument());
      expect(document.activeElement).toHaveTextContent("src/fresh.ts");
      expect(document.activeElement).not.toHaveTextContent("src/stale.ts");
    });

    // 1.T2 — ArrowDown/ArrowUp through interleaved header+match rows; Up-at-first returns to input
    it("ArrowDown moves cursor through header->match->match rows in order; ArrowUp at first row returns focus to input", async () => {
      const { input, container } = await renderWithResults();
      // Seed to first row via Enter in the input.
      fireEvent.keyDown(input, { key: "Enter" });
      expect(document.activeElement).toHaveClass("search-panel__file-header");

      // ArrowDown -> first match (src/a.ts:1)
      fireEvent.keyDown(container, { key: "ArrowDown" });
      expect(document.activeElement).toHaveClass("search-panel__match-row");
      expect(document.activeElement).toHaveTextContent("1");

      // ArrowDown -> second match (src/a.ts:2)
      fireEvent.keyDown(container, { key: "ArrowDown" });
      expect(document.activeElement).toHaveTextContent("2");

      // ArrowUp twice back to the header (first row).
      fireEvent.keyDown(container, { key: "ArrowUp" });
      fireEvent.keyDown(container, { key: "ArrowUp" });
      expect(document.activeElement).toHaveClass("search-panel__file-header");

      // ArrowUp at the first row -> onBoundary('top') -> focus returns to input.
      fireEvent.keyDown(container, { key: "ArrowUp" });
      expect(document.activeElement).toBe(input);
    });

    // 1.T3 — Enter on header toggles collapse; Enter on match commits
    it("Enter on a header row toggles that file's expanded state without opening a file", async () => {
      const { input, container } = await renderWithResults();
      expect(document.querySelectorAll(".search-panel__match-row")).toHaveLength(3);
      fireEvent.keyDown(input, { key: "Enter" }); // cursor on src/a.ts header
      fireEvent.keyDown(container, { key: "Enter" }); // toggle collapse
      expect(mockSetActiveFilePathAtLine).not.toHaveBeenCalled();
      // src/a.ts collapsed -> only src/b.ts's single match row remains.
      expect(document.querySelectorAll(".search-panel__match-row")).toHaveLength(1);
    });

    it("Enter on a match row calls setActiveFilePathAtLine", async () => {
      const { input, container } = await renderWithResults();
      fireEvent.keyDown(input, { key: "Enter" }); // header
      fireEvent.keyDown(container, { key: "ArrowDown" }); // src/a.ts:1
      fireEvent.keyDown(container, { key: "Enter" });
      expect(mockSetActiveFilePathAtLine).toHaveBeenCalledWith("wt-1", "src/a.ts", 1, "A");
      expect(mockSetToolPanelTab).toHaveBeenCalledWith("files");
    });

    // 1.T4 — Escape returns focus to input and clears cursor
    it("Escape from a results row refocuses the query input and clears the cursor", async () => {
      const { input, container } = await renderWithResults();
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(container, { key: "ArrowDown" }); // cursor on a match row
      fireEvent.keyDown(container, { key: "Escape" });
      expect(document.activeElement).toBe(input);
      // Cursor cleared -> first row becomes the tabbable fallback again.
      expect(document.querySelector("[tabindex='0']")?.classList.contains("search-panel__file-header")).toBe(true);
    });

    // 1.T8/S-3 — Ctrl/Cmd-click and Mod+Enter commit to a NEW tab; the new-tab
    // open must STILL jump to the matched line (S-3), so setActiveFilePathAtLine
    // is also called with the line after openFileTabNew (which takes none).
    it("Ctrl/Cmd-click on a match row opens a NEW tab AND sets the pending line (S-3)", async () => {
      const { input, container } = await renderWithResults();
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(container, { key: "ArrowDown" }); // src/a.ts:1
      const cursored = document.activeElement as HTMLElement;
      fireEvent.click(cursored, { ctrlKey: true });
      expect(mockOpenFileTabNew).toHaveBeenCalledWith("wt-1", "src/a.ts");
      // S-3: the line number must not be dropped when opening in a new tab.
      expect(mockSetActiveFilePathAtLine).toHaveBeenCalledWith("wt-1", "src/a.ts", 1, "A");
    });

    it("Mod+Enter on a cursored match row opens a NEW tab and sets the pending line (S-3); Mod+Enter on a header row is a no-op", async () => {
      const { input, container } = await renderWithResults();
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(container, { key: "ArrowDown" }); // src/a.ts:1
      fireEvent.keyDown(container, { key: "Enter", ctrlKey: true });
      expect(mockOpenFileTabNew).toHaveBeenCalledWith("wt-1", "src/a.ts");
      expect(mockSetActiveFilePathAtLine).toHaveBeenCalledWith("wt-1", "src/a.ts", 1, "A");

      mockOpenFileTabNew.mockClear();
      mockSetActiveFilePathAtLine.mockClear();
      // Back to header row.
      fireEvent.keyDown(container, { key: "ArrowUp" });
      fireEvent.keyDown(container, { key: "Enter", ctrlKey: true });
      expect(mockOpenFileTabNew).not.toHaveBeenCalled();
      expect(mockSetActiveFilePathAtLine).not.toHaveBeenCalled();
    });

    // 1.T9 — click updates cursorPath via onFocus so subsequent ArrowDown moves relative to it
    it("clicking a row updates cursorPath via onFocus, so a subsequent ArrowDown moves relative to the clicked row", async () => {
      const { container } = await renderWithResults();
      // Click the src/a.ts:2 match row (3rd row overall). In jsdom a click
      // doesn't move focus on its own, so explicitly focus (what a real browser
      // does on click-focus) to fire onFocus -> setCursorPath.
      const matchRows = document.querySelectorAll<HTMLElement>(".search-panel__match-row");
      fireEvent.click(matchRows[1]!); // src/a.ts:2
      fireEvent.focus(matchRows[1]!);
      expect(document.activeElement).toHaveTextContent("2");
      // ArrowDown now goes to the row AFTER src/a.ts:2 -> src/b.ts header.
      fireEvent.keyDown(container, { key: "ArrowDown" });
      expect(document.activeElement).toHaveClass("search-panel__file-header");
      expect(document.activeElement).toHaveTextContent("src/b.ts");
    });
  });

  // ── Phase 2: peekFile wiring ──
  describe("Peek preview wiring", () => {
    const peekResults: SearchResult = {
      files: [
        {
          path: "src/a.ts",
          matches: [{ line: 42, pre: "const ", mid: "X", post: " = 1" }],
        },
      ],
      truncated: false,
      totalMatches: 1,
    };

    async function renderWithPeekResults() {
      mockApi.search.mockResolvedValue(peekResults);
      render(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);
      const input = screen.getByPlaceholderText("Search content...");
      await userEvent.type(input, "test");
      vi.useFakeTimers();
      vi.advanceTimersByTime(200);
      vi.useRealTimers();
      await waitFor(() => {
        expect(screen.getByText("src/a.ts")).toBeInTheDocument();
      });
      const container = document.querySelector(
        ".search-panel__results-list",
      ) as HTMLElement;
      return { input, container };
    }

    // 2.T3 — arrowing onto a match row calls setPeekFile (debounced), no tab touched
    it("arrowing onto a match row calls setPeekFile (debounced) with that row's path/line", async () => {
      const { input, container } = await renderWithPeekResults();
      // Enable fake timers BEFORE arrowing so the peek effect's setTimeout is
      // scheduled under fake timers and advanceTimersByTime can fire it.
      vi.useFakeTimers();
      fireEvent.keyDown(input, { key: "Enter" }); // header
      fireEvent.keyDown(container, { key: "ArrowDown" }); // src/a.ts:42 match
      vi.advanceTimersByTime(200);
      vi.useRealTimers();
      expect(mockSetPeekFile).toHaveBeenCalledWith({ worktreeId: "wt-1", path: "src/a.ts", line: 42, matchText: "X" });
      // Peeking must not open a tab.
      expect(mockSetActiveFilePathAtLine).not.toHaveBeenCalled();
      expect(mockOpenFileTabNew).not.toHaveBeenCalled();
    });

    // 2.T3/2.4 — Enter commits via setActiveFilePathAtLine; SearchPanel itself does NOT
    // add a scattered clearPeekFile call (that lives centrally in the store action, 2.1a).
    it("Enter on a match row commits via setActiveFilePathAtLine without an explicit clearPeekFile", async () => {
      const { input, container } = await renderWithPeekResults();
      fireEvent.keyDown(input, { key: "Enter" }); // header
      fireEvent.keyDown(container, { key: "ArrowDown" }); // match
      mockClearPeekFile.mockClear();
      fireEvent.keyDown(container, { key: "Enter" }); // commit
      expect(mockSetActiveFilePathAtLine).toHaveBeenCalledWith("wt-1", "src/a.ts", 42, "X");
      // 2.4: no scattered clearPeekFile call from SearchPanel on commit — the store
      // action's own body (2.1a) is what clears peek.
      expect(mockClearPeekFile).not.toHaveBeenCalled();
    });

    // Live-review feedback (the "2 tabs" bug) — committing within the 200ms
    // peek-debounce window must cancel that pending timer, or it fires
    // afterward anyway and resurrects a peek/dedicated-tab for the file
    // that was just committed.
    it("committing (Enter) within the peek-debounce window cancels the pending peek — it never fires afterward", async () => {
      const { input, container } = await renderWithPeekResults();
      vi.useFakeTimers();
      fireEvent.keyDown(input, { key: "Enter" }); // header
      fireEvent.keyDown(container, { key: "ArrowDown" }); // match — arms the 200ms peek timer
      fireEvent.keyDown(container, { key: "Enter" }); // commit, BEFORE the 200ms elapses
      expect(mockSetActiveFilePathAtLine).toHaveBeenCalledWith("wt-1", "src/a.ts", 42, "X");

      mockSetPeekFile.mockClear();
      vi.advanceTimersByTime(200);
      vi.useRealTimers();
      // The stale timer must NOT have fired.
      expect(mockSetPeekFile).not.toHaveBeenCalled();
    });

    // 2.T5/S4 — a query that shrinks to zero results clears the peek
    it("a query that shrinks results to zero clears peekFile", async () => {
      mockApi.search
        .mockResolvedValueOnce(peekResults)
        .mockResolvedValueOnce({ files: [], truncated: false, totalMatches: 0 });
      render(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);
      const input = screen.getByPlaceholderText("Search content...");
      await userEvent.type(input, "abc");
      vi.useFakeTimers();
      vi.advanceTimersByTime(200);
      vi.useRealTimers();
      await waitFor(() => expect(screen.getByText("src/a.ts")).toBeInTheDocument());
      const container = document.querySelector(".search-panel__results-list") as HTMLElement;
      // Arrow onto the match -> peek set.
      vi.useFakeTimers();
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(container, { key: "ArrowDown" });
      vi.advanceTimersByTime(200);
      vi.useRealTimers();
      expect(mockSetPeekFile).toHaveBeenCalledWith({ worktreeId: "wt-1", path: "src/a.ts", line: 42, matchText: "X" });

      // Type a follow-up character -> new query -> zero results -> peek cleared.
      mockClearPeekFile.mockClear();
      await userEvent.type(input, "d");
      vi.useFakeTimers();
      vi.advanceTimersByTime(200);
      vi.useRealTimers();
      await waitFor(() => expect(screen.getByText("No matches found")).toBeInTheDocument());
      expect(mockClearPeekFile).toHaveBeenCalled();
      // And no new peek is set for a row that no longer exists.
      mockSetPeekFile.mockClear();
      vi.useFakeTimers();
      vi.advanceTimersByTime(300);
      vi.useRealTimers();
      expect(mockSetPeekFile).not.toHaveBeenCalled();
    });

    // S-1 — Escape is a pure focus action (Decision 3); it must NOT blank the
    // preview by clearing the peek. Only a cursor nulled by the result set
    // emptying clears the peek.
    it("S-1 — Escape from a results row leaves an active peek showing (does not clear it)", async () => {
      const { input, container } = await renderWithPeekResults();
      // Arrow onto the match row -> debounced peek is set.
      vi.useFakeTimers();
      fireEvent.keyDown(input, { key: "Enter" }); // header
      fireEvent.keyDown(container, { key: "ArrowDown" }); // src/a.ts:42 match
      vi.advanceTimersByTime(200);
      vi.useRealTimers();
      expect(mockSetPeekFile).toHaveBeenCalledWith({ worktreeId: "wt-1", path: "src/a.ts", line: 42, matchText: "X" });

      // Escape nulls the cursor and returns focus to the input — the peek
      // must survive (rows still present), not blank the preview.
      mockClearPeekFile.mockClear();
      fireEvent.keyDown(container, { key: "Escape" });
      expect(mockClearPeekFile).not.toHaveBeenCalled();
      expect(mockSetPeekFile).toHaveBeenCalledTimes(1); // still the one from arrowing
    });

    // 2.T3 (a) typing a new query passes ifSource: 'search' preserving definition peeks;
    // (b) arrow-roving through 5 search results passes coalesce: true (coalesce guard).
    it("2.T3 — (a) query change passes ifSource: 'search'; (b) arrow-roving through 5 matches passes coalesce: true", async () => {
      const fiveMatches: SearchResult = {
        files: [
          {
            path: "src/a.ts",
            matches: [
              { line: 1, pre: "", mid: "one", post: "" },
              { line: 2, pre: "", mid: "two", post: "" },
              { line: 3, pre: "", mid: "three", post: "" },
              { line: 4, pre: "", mid: "four", post: "" },
              { line: 5, pre: "", mid: "five", post: "" },
            ],
          },
        ],
        truncated: false,
        totalMatches: 5,
      };

      mockApi.search.mockResolvedValue(fiveMatches);
      render(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);
      const input = screen.getByPlaceholderText("Search content...");

      // (a) Typing query clears only search-sourced peeks (ifSource: "search")
      mockClearPeekFile.mockClear();
      await userEvent.type(input, "query");
      expect(mockClearPeekFile).toHaveBeenCalledWith({ ifSource: "search" });

      vi.useFakeTimers();
      vi.advanceTimersByTime(200);
      vi.useRealTimers();

      await waitFor(() => expect(screen.getByText("src/a.ts")).toBeInTheDocument());
      const container = document.querySelector(".search-panel__results-list") as HTMLElement;

      // (b) Arrow-rove through the 5 matches
      mockPushJump.mockClear();
      vi.useFakeTimers();
      fireEvent.keyDown(input, { key: "Enter" }); // focus header
      for (let i = 1; i <= 5; i++) {
        fireEvent.keyDown(container, { key: "ArrowDown" });
        vi.advanceTimersByTime(200);
      }
      vi.useRealTimers();

      // Every roving jump was called with coalesce: true and source: "search"
      expect(mockPushJump).toHaveBeenCalledTimes(5);
      for (const call of mockPushJump.mock.calls) {
        expect(call[0]).toMatchObject({
          worktreeId: "wt-1",
          path: "src/a.ts",
          source: "search",
          coalesce: true,
        });
      }
    });
  });

  describe("Sticky toggle prefs", () => {
    it("loads persisted case/regex/word state from settings on mount", async () => {
      (mockApi.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        defaultProjectsDir: "/tmp",
        searchCaseSensitive: true,
        searchRegex: false,
        searchWholeWord: true,
      });

      render(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);

      await waitFor(() => {
        expect(screen.getByLabelText("Case sensitive")).toHaveClass("active");
      });
      expect(screen.getByLabelText("Whole word")).toHaveClass("active");
      expect(screen.getByLabelText("Regular expression")).not.toHaveClass("active");
    });

    it("persists a toggle change via updateSettings", async () => {
      render(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);

      await waitFor(() => expect(mockApi.getSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByLabelText("Case sensitive"));

      expect(screen.getByLabelText("Case sensitive")).toHaveClass("active");
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ searchCaseSensitive: true });
    });
  });

  describe("Phase 3.7a — query-input focus behavior (B4b/B4c)", () => {
    it("does not focus the query input on ordinary mount in tree mode (no autoFocus)", () => {
      render(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);
      expect(screen.getByPlaceholderText("Search content...")).not.toHaveFocus();
    });

    it("focuses the query input when filesLeftPaneMode transitions to 'search'", () => {
      const { rerender } = render(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);
      const input = screen.getByPlaceholderText("Search content...");
      expect(input).not.toHaveFocus();

      mockStoreState.filesLeftPaneMode = { "wt-1": "search" };
      rerender(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);

      expect(input).toHaveFocus();
    });

    it("focuses the query input on an explicit searchFocusSeq request (Mod+Shift+F)", () => {
      const { rerender } = render(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);
      const input = screen.getByPlaceholderText("Search content...");
      expect(input).not.toHaveFocus();

      mockStoreState.searchFocusSeq = { "wt-1": 1 };
      rerender(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);

      expect(input).toHaveFocus();
    });

    // Multi-tools-tile canvas correctness: a request for a DIFFERENT
    // worktree's search panel must not steal focus into this one.
    it("does NOT focus when searchFocusSeq bumps for a different worktree", () => {
      const { rerender } = render(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);
      const input = screen.getByPlaceholderText("Search content...");
      expect(input).not.toHaveFocus();

      mockStoreState.searchFocusSeq = { "wt-2": 1 };
      rerender(<SearchPanel api={mockApi} worktreeId="wt-1" scope="worktree" />);

      expect(input).not.toHaveFocus();
    });
  });
});
