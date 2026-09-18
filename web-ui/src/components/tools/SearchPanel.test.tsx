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
const mockSetToolPanelTab = vi.fn();
vi.mock("@/hooks/useStore", () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) => {
    const state = {
      setActiveFilePathAtLine: mockSetActiveFilePathAtLine,
      setToolPanelTab: mockSetToolPanelTab,
    };
    return selector(state);
  },
}));

describe("SearchPanel", () => {
  let mockApi: MockSearchApi;

  beforeEach(() => {
    vi.clearAllMocks();
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
    it("calls setActiveFilePathAtLine and switches to Files tab", async () => {
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

      fireEvent.click(matchRow!);

      expect(mockSetActiveFilePathAtLine).toHaveBeenCalledWith("wt-1", "src/test.tsx", 42);
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
});
