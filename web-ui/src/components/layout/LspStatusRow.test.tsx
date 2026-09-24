import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { LspStatusRow } from "./LspStatusRow";
import { useWorkspaceStore } from "@/hooks/useStore";
import * as lspApi from "@/lib/lspApi";

describe("LspStatusRow", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      activeFilePath: "main.rs",
      peekFile: null,
      diffScopeByWorktree: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing when no file is previewed", async () => {
    useWorkspaceStore.setState({ activeFilePath: null, peekFile: null });
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({ status: "ready", language: "rust" });

    const { container } = render(<LspStatusRow api={{}} worktreeId="wt-1" />);

    // Give any in-flight poll a chance to resolve — it shouldn't render.
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the language name plus one-word status for the currently previewed file", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({ status: "ready", language: "rust" });

    render(<LspStatusRow api={{}} worktreeId="wt-1" />);

    expect(await screen.findByText("Rust LSP: Ready")).toBeInTheDocument();
  });

  it("maps not_found to 'Unavailable' and unsupported to 'N/A', with no language prefix when language is unknown", async () => {
    const spy = vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({ status: "not_found", language: null });
    const { rerender } = render(<LspStatusRow api={{}} worktreeId="wt-1" />);
    expect(await screen.findByText("LSP: Unavailable")).toBeInTheDocument();

    spy.mockResolvedValue({ status: "unsupported", language: null });
    useWorkspaceStore.setState({ activeFilePath: "main.go" });
    rerender(<LspStatusRow api={{}} worktreeId="wt-1" />);
    expect(await screen.findByText("LSP: N/A")).toBeInTheDocument();
  });

  it("opens a popup with the full detail text when clicked", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({ status: "starting", language: "rust" });
    vi.spyOn(lspApi, "getLspStatuses").mockResolvedValue([{ language: "rust", status: "starting" }]);

    render(<LspStatusRow api={{}} worktreeId="wt-1" />);

    const trigger = await screen.findByText("Rust LSP: Starting");
    fireEvent.click(trigger);

    expect(await screen.findByText("LSP: starting…")).toBeInTheDocument();
  });

  it("clicking the popup's action button resumes a stopped server", async () => {
    const statusSpy = vi
      .spyOn(lspApi, "getLspStatus")
      .mockResolvedValueOnce({ status: "stopped", language: "rust" })
      .mockResolvedValueOnce({ status: "starting", language: "rust" });
    const hoverSpy = vi.spyOn(lspApi, "getHover").mockResolvedValue({ empty: true });
    vi.spyOn(lspApi, "getLspStatuses").mockResolvedValue([{ language: "rust", status: "stopped" }]);

    render(<LspStatusRow api={{}} worktreeId="wt-1" />);

    fireEvent.click(await screen.findByText("Rust LSP: Stopped"));
    fireEvent.click(await screen.findByText("Resume"));

    await waitFor(() => {
      expect(hoverSpy).toHaveBeenCalled();
      expect(statusSpy).toHaveBeenCalledTimes(2);
    });
  });

  it("popup fetches and renders every tracked language's status, marking the current one", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({ status: "ready", language: "rust" });
    const statusesSpy = vi.spyOn(lspApi, "getLspStatuses").mockResolvedValue([
      { language: "rust", status: "ready" },
      { language: "typescript", status: "starting" },
    ]);

    render(<LspStatusRow api={{}} worktreeId="wt-1" />);

    fireEvent.click(await screen.findByText("Rust LSP: Ready"));

    await waitFor(() => expect(statusesSpy).toHaveBeenCalledWith({}, "worktree", "wt-1"));

    const currentRow = await screen.findByText("Rust: Ready");
    const otherRow = await screen.findByText("Typescript: Starting");
    expect(currentRow.closest(".lsp-status-row__popup-lang-row")).toHaveClass(
      "lsp-status-row__popup-lang-row--current"
    );
    expect(otherRow.closest(".lsp-status-row__popup-lang-row")).not.toHaveClass(
      "lsp-status-row__popup-lang-row--current"
    );
  });

  it("shows a loading line while the per-language breakdown is in flight", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({ status: "ready", language: "rust" });
    let resolveStatuses: (v: lspApi.LspLanguageStatus[]) => void = () => {};
    vi.spyOn(lspApi, "getLspStatuses").mockReturnValue(
      new Promise((resolve) => {
        resolveStatuses = resolve;
      })
    );

    render(<LspStatusRow api={{}} worktreeId="wt-1" />);

    fireEvent.click(await screen.findByText("Rust LSP: Ready"));
    expect(await screen.findByText("Loading…")).toBeInTheDocument();

    resolveStatuses([{ language: "rust", status: "ready" }]);
    await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());
  });
});
