import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { LspStatusBadge } from "./LspStatusBadge";
import * as lspApi from "@/lib/lspApi";

describe("LspStatusBadge", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows 'LSP: ready' when status is ready", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
      status: "ready",
      language: "rust",
    });

    render(<LspStatusBadge api={{}} worktreeId="wt-1" path="main.rs" />);

    expect(await screen.findByText("LSP: ready")).toBeInTheDocument();
  });

  it("shows 'LSP: starting…' when status is starting", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
      status: "starting",
      language: "rust",
    });

    render(<LspStatusBadge api={{}} worktreeId="wt-1" path="main.rs" />);

    expect(await screen.findByText("LSP: starting…")).toBeInTheDocument();
  });

  it("shows 'LSP: indexing…' when status is indexing", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
      status: "indexing",
      language: "rust",
    });

    render(<LspStatusBadge api={{}} worktreeId="wt-1" path="main.rs" />);

    expect(await screen.findByText("LSP: indexing…")).toBeInTheDocument();
  });

  it("shows 'LSP: not available for Rust — server not found on host' for unsupported/not_found with language", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
      status: "not_found",
      language: "rust",
    });

    render(<LspStatusBadge api={{}} worktreeId="wt-1" path="main.rs" />);

    expect(
      await screen.findByText("LSP: not available for Rust — server not found on host")
    ).toBeInTheDocument();
  });

  it("shows 'LSP: idle' when status is idle", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
      status: "idle",
      language: "rust",
    });

    render(<LspStatusBadge api={{}} worktreeId="wt-1" path="main.rs" />);

    expect(await screen.findByText("LSP: idle")).toBeInTheDocument();
  });

  it("shows 'LSP: stopped — click to resume' when status is stopped", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
      status: "stopped",
      language: "rust",
    });

    render(<LspStatusBadge api={{}} worktreeId="wt-1" path="main.rs" />);

    expect(await screen.findByText("LSP: stopped — click to resume")).toBeInTheDocument();
  });

  it("5.13: clicking stopped badge prompts a request and re-polls status", async () => {
    const statusSpy = vi.spyOn(lspApi, "getLspStatus")
      .mockResolvedValueOnce({
        status: "stopped",
        language: "rust",
      })
      .mockResolvedValueOnce({
        status: "starting",
        language: "rust",
      });

    const hoverSpy = vi.spyOn(lspApi, "getHover").mockResolvedValue({ empty: true });

    render(<LspStatusBadge api={{}} worktreeId="wt-1" path="main.rs" />);

    const badge = await screen.findByText("LSP: stopped — click to resume");
    fireEvent.click(badge);

    await waitFor(() => {
      expect(hoverSpy).toHaveBeenCalledWith(
        expect.anything(),
        "worktree",
        "wt-1",
        { kind: "workspace", path: "main.rs" },
        0,
        0
      );
      expect(statusSpy).toHaveBeenCalledTimes(2);
    });

    expect(await screen.findByText("LSP: starting…")).toBeInTheDocument();
  });

  it("polls periodically every 5000ms", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const spy = vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
        status: "ready",
        language: "rust",
      });

      render(<LspStatusBadge api={{}} worktreeId="wt-1" path="main.rs" />);

      await waitFor(() => {
        expect(spy).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(spy).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("2.T5: renders disabled badge, title tooltip, and clicking enables worktree LSP", async () => {
    const statusSpy = vi.spyOn(lspApi, "getLspStatus")
      .mockResolvedValueOnce({
        status: "disabled",
        language: "rust",
      })
      .mockResolvedValueOnce({
        status: "starting",
        language: "rust",
      });

    const setWorktreeLspEnabled = vi.fn().mockResolvedValue({ id: "wt-1", lspEnabled: true });
    const mockApi = { setWorktreeLspEnabled };

    render(<LspStatusBadge api={mockApi} worktreeId="wt-1" path="main.rs" />);

    const badge = await screen.findByText("LSP: disabled — click to enable");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass("lsp-status-badge--disabled");
    expect(badge).toHaveClass("lsp-status-badge--clickable");
    expect(badge).toHaveAttribute("title", "LSP is disabled for this workspace. Click to enable.");

    fireEvent.click(badge);

    await waitFor(() => {
      expect(setWorktreeLspEnabled).toHaveBeenCalledWith("wt-1", true);
      expect(statusSpy).toHaveBeenCalledTimes(2);
    });

    expect(await screen.findByText("LSP: starting…")).toBeInTheDocument();
  });

  it("2.T6: clicking disabled badge with scope='project' calls setProjectLspEnabled", async () => {
    const statusSpy = vi.spyOn(lspApi, "getLspStatus")
      .mockResolvedValueOnce({
        status: "disabled",
        language: "rust",
      })
      .mockResolvedValueOnce({
        status: "ready",
        language: "rust",
      });

    const setProjectLspEnabled = vi.fn().mockResolvedValue({ id: "proj-1", lspEnabled: true });
    const mockApi = { setProjectLspEnabled };

    render(<LspStatusBadge api={mockApi} worktreeId="proj-1" scope="project" path="main.rs" />);

    const badge = await screen.findByText("LSP: disabled — click to enable");
    fireEvent.click(badge);

    await waitFor(() => {
      expect(setProjectLspEnabled).toHaveBeenCalledWith("proj-1", true);
      expect(statusSpy).toHaveBeenCalledTimes(2);
    });

    expect(await screen.findByText("LSP: ready")).toBeInTheDocument();
  });
});

