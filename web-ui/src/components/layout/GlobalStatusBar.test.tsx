import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { GlobalStatusBar } from "./GlobalStatusBar";
import { useWorkspaceStore } from "@/hooks/useStore";
import * as lspApi from "@/lib/lspApi";

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
      detail: "LSP: ready",
      action: null,
      actionLabel: null,
    });
    render(<GlobalStatusBar api={{}} projects={projects} worktrees={worktrees} />);
    expect(await screen.findByText("Rust LSP: Ready")).toBeInTheDocument();
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
      detail: "LSP: ready",
      action: null,
      actionLabel: null,
    });

    render(<GlobalStatusBar api={{}} projects={projects} worktrees={[]} />);

    fireEvent.click(await screen.findByText("Rust LSP: Ready"));
    await waitFor(() => expect(statusesSpy).toHaveBeenCalledWith({}, "project", "proj-1"));
  });
});
