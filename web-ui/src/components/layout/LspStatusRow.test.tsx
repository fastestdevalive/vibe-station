import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { LspStatusRow } from "./LspStatusRow";
import { useWorkspaceStore } from "@/hooks/useStore";
import * as lspApi from "@/lib/lspApi";
import type { LspAction, LspLanguageStatus, LspSeverity, LspStatus, LspStatusResponse } from "@/lib/lspApi";

/** Mirrors `vst_lsp::status::describe`'s per-state table for test fixtures —
 *  keeps mocks realistic without duplicating the full backend match here. */
function presentationFor(
  status: LspStatus,
  language: string | null,
): Pick<LspStatusResponse, "label" | "displayName" | "severity" | "detail" | "action" | "actionLabel"> {
  const displayNames: Record<string, string> = {
    rust: "Rust",
    typescript: "TypeScript / JavaScript",
    go: "Go",
  };
  const displayName = language ? displayNames[language] ?? language : null;
  const table: Record<
    LspStatus,
    { label: string; severity: LspSeverity; detail: string; action: LspAction | null; actionLabel: string | null }
  > = {
    ready: { label: "Ready", severity: "ok", detail: "LSP: ready", action: null, actionLabel: null },
    starting: { label: "Starting", severity: "warn", detail: "LSP: starting…", action: null, actionLabel: null },
    indexing: { label: "Indexing", severity: "warn", detail: "LSP: indexing…", action: null, actionLabel: null },
    idle: { label: "Idle", severity: "neutral", detail: "LSP: idle", action: "resume", actionLabel: "Resume" },
    stopped: {
      label: "Stopped",
      severity: "neutral",
      detail: "LSP: stopped — click to resume",
      action: "resume",
      actionLabel: "Resume",
    },
    disabled: {
      label: "Disabled",
      severity: "neutral",
      detail: "LSP is disabled for this workspace — click to enable.",
      action: "enable",
      actionLabel: "Enable",
    },
    not_found: {
      label: "Unavailable",
      // Neutral, not Warn — a steady-state "not installed on this host" fact,
      // not a transient busy-state like starting/indexing (which are Warn).
      severity: "neutral",
      detail: displayName
        ? `LSP: not available for ${displayName} — server not found on host`
        : "LSP: not available — server not found on host",
      action: null,
      actionLabel: null,
    },
    unsupported: {
      label: "N/A",
      severity: "neutral",
      // Always this sentence — `describe()` never branches on displayName here,
      // since `Unsupported` is never actually reached with a language.
      detail: "LSP: unsupported file type",
      action: null,
      actionLabel: null,
    },
    error: { label: "Error", severity: "error", detail: "LSP: server error", action: null, actionLabel: null },
  };
  const p = table[status];
  return { label: p.label, displayName, severity: p.severity, detail: p.detail, action: p.action, actionLabel: p.actionLabel };
}

function mockStatus(status: LspStatus, language: string | null): LspStatusResponse {
  return { status, language, ...presentationFor(status, language) };
}

function mockLangStatus(status: LspStatus, language: string): LspLanguageStatus {
  return { status, language, ...presentationFor(status, language) };
}

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
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("ready", "rust"));

    const { container } = render(<LspStatusRow api={{}} worktreeId="wt-1" />);

    // Give any in-flight poll a chance to resolve — it shouldn't render.
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the language name plus one-word status for the currently previewed file", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("ready", "rust"));

    render(<LspStatusRow api={{}} worktreeId="wt-1" />);

    expect(await screen.findByText("Rust LSP: Ready")).toBeInTheDocument();
  });

  it("maps not_found to 'Unavailable' and unsupported to 'N/A', with no language prefix when language is unknown", async () => {
    const spy = vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("not_found", null));
    const { rerender } = render(<LspStatusRow api={{}} worktreeId="wt-1" />);
    expect(await screen.findByText("LSP: Unavailable")).toBeInTheDocument();

    spy.mockResolvedValue(mockStatus("unsupported", null));
    useWorkspaceStore.setState({ activeFilePath: "main.go" });
    rerender(<LspStatusRow api={{}} worktreeId="wt-1" />);
    expect(await screen.findByText("LSP: N/A")).toBeInTheDocument();
  });

  it("dot class comes from backend severity, not raw status", async () => {
    // `not_found` and `error` are both "not working" but must render differently:
    // not_found -> neutral/gray (steady host fact), error -> red (something broke).
    const spy = vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("not_found", "rust"));
    const { container, rerender } = render(<LspStatusRow api={{}} worktreeId="wt-1" />);
    await screen.findByText("Rust LSP: Unavailable");
    expect(container.querySelector(".lsp-status-row__dot--gray")).toBeInTheDocument();
    expect(container.querySelector(".lsp-status-row__dot--red")).not.toBeInTheDocument();

    // Changing the previewed path (like the not_found/unsupported test above) is what
    // re-triggers the hook's fetch effect immediately, instead of waiting on the 5s poll.
    spy.mockResolvedValue(mockStatus("error", "rust"));
    useWorkspaceStore.setState({ activeFilePath: "other.rs" });
    rerender(<LspStatusRow api={{}} worktreeId="wt-1" />);
    await screen.findByText("Rust LSP: Error");
    expect(container.querySelector(".lsp-status-row__dot--red")).toBeInTheDocument();
  });

  it("opens a popup with the full detail text when clicked", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("starting", "rust"));
    vi.spyOn(lspApi, "getLspStatuses").mockResolvedValue([mockLangStatus("starting", "rust")]);

    render(<LspStatusRow api={{}} worktreeId="wt-1" />);

    const trigger = await screen.findByText("Rust LSP: Starting");
    fireEvent.click(trigger);

    expect(await screen.findByText("LSP: starting…")).toBeInTheDocument();
  });

  it("clicking the popup's action button resumes a stopped server", async () => {
    const statusSpy = vi
      .spyOn(lspApi, "getLspStatus")
      .mockResolvedValueOnce(mockStatus("stopped", "rust"))
      .mockResolvedValueOnce(mockStatus("starting", "rust"));
    const hoverSpy = vi.spyOn(lspApi, "getHover").mockResolvedValue({ empty: true });
    vi.spyOn(lspApi, "getLspStatuses").mockResolvedValue([mockLangStatus("stopped", "rust")]);

    render(<LspStatusRow api={{}} worktreeId="wt-1" />);

    fireEvent.click(await screen.findByText("Rust LSP: Stopped"));
    fireEvent.click(await screen.findByText("Resume"));

    await waitFor(() => {
      expect(hoverSpy).toHaveBeenCalled();
      expect(statusSpy).toHaveBeenCalledTimes(2);
    });
  });

  it("popup fetches and renders every tracked language's status, marking the current one", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("ready", "rust"));
    const statusesSpy = vi.spyOn(lspApi, "getLspStatuses").mockResolvedValue([
      mockLangStatus("ready", "rust"),
      mockLangStatus("starting", "typescript"),
    ]);

    render(<LspStatusRow api={{}} worktreeId="wt-1" />);

    fireEvent.click(await screen.findByText("Rust LSP: Ready"));

    await waitFor(() => expect(statusesSpy).toHaveBeenCalledWith({}, "worktree", "wt-1"));

    const currentRow = await screen.findByText("Rust: Ready");
    const otherRow = await screen.findByText("TypeScript / JavaScript: Starting");
    expect(currentRow.closest(".lsp-status-row__popup-lang-row")).toHaveClass(
      "lsp-status-row__popup-lang-row--current"
    );
    expect(otherRow.closest(".lsp-status-row__popup-lang-row")).not.toHaveClass(
      "lsp-status-row__popup-lang-row--current"
    );
  });

  it("shows a loading line while the per-language breakdown is in flight", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("ready", "rust"));
    let resolveStatuses: (v: lspApi.LspLanguageStatus[]) => void = () => {};
    vi.spyOn(lspApi, "getLspStatuses").mockReturnValue(
      new Promise((resolve) => {
        resolveStatuses = resolve;
      })
    );

    render(<LspStatusRow api={{}} worktreeId="wt-1" />);

    fireEvent.click(await screen.findByText("Rust LSP: Ready"));
    expect(await screen.findByText("Loading…")).toBeInTheDocument();

    resolveStatuses([mockLangStatus("ready", "rust")]);
    await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());
  });
});
