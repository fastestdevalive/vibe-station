import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { GlobalStatusBar } from "./GlobalStatusBar";
import { useWorkspaceStore } from "@/hooks/useStore";
import * as lspApi from "@/lib/lspApi";

// Keep the existing breadcrumb/LSP tests hermetic: LimitsBar calls useLimits()
// (which would otherwise boot and hit the real API). Provide a stable fake
// snapshot so the two chips render deterministically.
vi.mock("@/hooks/useLimits", () => {
  const slots = [
    { harness: "claude", windowId: "five_hour" },
    { harness: "claude", windowId: "seven_day" },
  ];
  const asOf = new Date().toISOString();
  const resetsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const harnesses = [
    {
      harness: "claude",
      status: "ok",
      message: null,
      asOf,
      windows: [
        { harness: "claude", windowId: "five_hour", cadenceMinutes: 300, usedPct: 42, resetsAt, asOf, status: "ok" },
        { harness: "claude", windowId: "seven_day", cadenceMinutes: 10080, usedPct: 61, resetsAt, asOf, status: "ok" },
      ],
    },
  ];
  const snapshot = { host: "test-host", slots, harnesses };
  return {
    useLimits: () => ({
      snapshot,
      loading: false,
      error: null,
      refreshing: false,
      cooldownUntil: null,
      slots,
      windowFor: (ref: { harness: string; windowId: string }) =>
        harnesses.find((h) => h.harness === ref.harness)?.windows.find((w) => w.windowId === ref.windowId),
      resultFor: (h: string) => harnesses.find((x) => x.harness === h),
      refresh: () => Promise.resolve(),
      assignSlot: () => Promise.resolve(),
    }),
  };
});

const mockUseMediaQuery = vi.hoisted(() => vi.fn(() => false));
const mockKeyboardVisible = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/hooks/useMediaQuery", () => ({ useMediaQuery: mockUseMediaQuery }));
vi.mock("@/hooks/useVirtualKeyboardVisible", () => ({ useVirtualKeyboardVisible: mockKeyboardVisible }));

const projects = [
  {
    id: "proj-1",
    name: "My Project",
    path: "/p",
    prefix: "p",
    isGit: true,
    createdAt: "2026-01-01",
    hidden: false,
    lspEnabled: true,
  },
];

const worktrees = [
  {
    id: "wt-1",
    projectId: "proj-1",
    name: "wt-1",
    branch: "feat/foo",
    baseBranch: "main",
    createdAt: "2026-01-01",
    pinnedAt: null,
    hiddenAt: null,
    lspEnabled: true,
  },
];

describe("GlobalStatusBar", () => {
  beforeEach(() => {
    mockUseMediaQuery.mockReturnValue(false);
    mockKeyboardVisible.mockReturnValue(false);
    useWorkspaceStore.setState({
      activeProjectId: "proj-1",
      activeWorktreeId: "wt-1",
      activeFilePath: "main.rs",
      peekFile: null,
      diffScopeByWorktree: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the active project name and worktree branch", () => {
    render(<GlobalStatusBar api={{}} projects={projects} worktrees={worktrees} />);
    expect(screen.getByText("My Project")).toBeInTheDocument();
    expect(screen.getByText("feat/foo")).toBeInTheDocument();
  });

  it("shows a dash when no project or worktree is active", () => {
    useWorkspaceStore.setState({ activeProjectId: null, activeWorktreeId: null });
    render(<GlobalStatusBar api={{}} projects={projects} worktrees={worktrees} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders the LSP status for the active worktree", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
      status: "ready",
      language: "rust",
      label: "Ready",
      displayName: "Rust",
      severity: "ok",
      detail: "Language server is ready.",
      action: null,
      actionLabel: null,
    });
    render(<GlobalStatusBar api={{}} projects={projects} worktrees={worktrees} />);
    expect(await screen.findByText("Rust")).toBeInTheDocument();
  });

  it("scopes the LSP status to the active project for a direct session (no worktree)", async () => {
    useWorkspaceStore.setState({ activeWorktreeId: null, activeProjectId: "proj-1" });
    const statusesSpy = vi.spyOn(lspApi, "getLspStatuses").mockResolvedValue([]);
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
      status: "ready",
      language: "rust",
      label: "Ready",
      displayName: "Rust",
      severity: "ok",
      detail: "Language server is ready.",
      action: null,
      actionLabel: null,
    });

    render(<GlobalStatusBar api={{}} projects={projects} worktrees={[]} />);

    fireEvent.click(await screen.findByText("Rust"));
    await waitFor(() => expect(statusesSpy).toHaveBeenCalledWith({}, "project", "proj-1"));
  });

  it("renders the harness-limit chips before the LSP row", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
      status: "ready",
      language: "rust",
      label: "Ready",
      displayName: "Rust",
      severity: "ok",
      detail: "LSP: ready",
      action: null,
      actionLabel: null,
    });
    render(<GlobalStatusBar api={{}} projects={projects} worktrees={worktrees} />);

    const chip = screen.getByRole("button", { name: /Slot 1/ });
    const lsp = await screen.findByText("Rust");
    expect(chip).toBeInTheDocument();
    // The chips (limits bar) come before the LSP row in the footer.
    expect(chip.compareDocumentPosition(lsp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides the whole footer (chips included) when a mobile virtual keyboard is up", () => {
    mockUseMediaQuery.mockReturnValue(true);
    mockKeyboardVisible.mockReturnValue(true);
    const { container } = render(<GlobalStatusBar api={{}} projects={projects} worktrees={worktrees} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("button", { name: /Slot 1/ })).not.toBeInTheDocument();
  });
});
