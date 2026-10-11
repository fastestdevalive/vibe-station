import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { LspStatusRow } from "./LspStatusRow";
import { useWorkspaceStore } from "@/hooks/useStore";
import type { FileScope, LspLanguageSurveyResponse } from "@/api/types";
import * as lspApi from "@/lib/lspApi";
import type {
  LspAction,
  LspFailure,
  LspLanguageStatus,
  LspSeverity,
  LspStatus,
  LspStatusResponse,
} from "@/lib/lspApi";

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
    python: "Python",
    ruby: "Ruby",
    c: "C / C++",
  };
  const displayName = language ? displayNames[language] ?? language : null;
  const table: Record<
    LspStatus,
    { label: string; severity: LspSeverity; detail: string; action: LspAction | null; actionLabel: string | null }
  > = {
    ready: { label: "Ready", severity: "ok", detail: "Language server is ready.", action: null, actionLabel: null },
    starting: {
      label: "Starting",
      severity: "warn",
      detail: "Launching the language server.",
      action: null,
      actionLabel: null,
    },
    indexing: {
      label: "Indexing",
      severity: "warn",
      detail: "Results may be incomplete until indexing finishes.",
      action: null,
      actionLabel: null,
    },
    idle: {
      label: "Sleeping",
      severity: "neutral",
      detail: "Wakes when you use code navigation.",
      action: "resume",
      actionLabel: "Start now",
    },
    stopped: {
      label: "Not running",
      severity: "neutral",
      detail: "Start to enable code navigation.",
      action: "resume",
      actionLabel: "Start",
    },
    disabled: {
      label: "Off",
      severity: "neutral",
      detail: "Code navigation is off for this workspace.",
      action: "enable",
      actionLabel: "Turn on",
    },
    not_found: {
      label: "Not installed",
      severity: "warn",
      detail: displayName ? `${displayName} isn't installed.` : "The language server isn't installed.",
      action: null,
      actionLabel: null,
    },
    unsupported: {
      label: "N/A",
      severity: "neutral",
      detail: "No language server for this file type.",
      action: null,
      actionLabel: null,
    },
    error: { label: "Error", severity: "error", detail: "No details available.", action: "retry", actionLabel: "Restart" },
  };
  const p = table[status];
  return { label: p.label, displayName, severity: p.severity, detail: p.detail, action: p.action, actionLabel: p.actionLabel };
}

function mockStatus(
  status: LspStatus,
  language: string | null,
  extra?: Partial<LspStatusResponse>,
): LspStatusResponse {
  return { status, language, ...presentationFor(status, language), ...extra };
}

function mockLangStatus(
  status: LspStatus,
  language: string,
  extra?: Partial<LspLanguageStatus>,
): LspLanguageStatus {
  return { status, language, ...presentationFor(status, language), ...extra };
}

describe("LspStatusRow", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      activeFilePath: "main.rs",
      peekFile: null,
      diffScopeByWorktree: {},
    });
    vi.spyOn(lspApi, "getLspStatuses").mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing when no file is previewed", async () => {
    useWorkspaceStore.setState({ activeFilePath: null, peekFile: null });
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("ready", "rust"));

    const { container } = render(<LspStatusRow api={{}} worktreeId="wt-1" />);

    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the language name for the currently previewed file (ready state omits state word)", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("ready", "rust"));

    const { container } = render(<LspStatusRow api={{}} worktreeId="wt-1" />);

    const trigger = await screen.findByRole("button", { name: "Rust" });
    expect(trigger).toBeInTheDocument();
    expect(container.querySelector(".lsp-status-row__state")).toBeNull();
    expect(container.querySelector(".lsp-status-row__dot--ok")).toBeInTheDocument();
  });

  it("renders short name plus state word when not ready", async () => {
    const spy = vi.spyOn(lspApi, "getLspStatus");

    // Starting: spinner
    spy.mockResolvedValue(mockStatus("starting", "rust"));
    const { container, rerender } = render(<LspStatusRow api={{}} worktreeId="wt-1" />);
    expect(await screen.findByRole("button", { name: /Rust.*Starting/ })).toBeInTheDocument();
    expect(container.querySelector(".lsp-status-row__spin")).toBeInTheDocument();

    // Idle / Sleeping: hollow dot
    spy.mockResolvedValue(mockStatus("idle", "rust"));
    useWorkspaceStore.setState({ activeFilePath: "idle.rs" });
    rerender(<LspStatusRow api={{}} worktreeId="wt-1" />);
    expect(await screen.findByRole("button", { name: /Rust.*Sleeping/ })).toBeInTheDocument();
    expect(container.querySelector(".lsp-status-row__dot--off")).toBeInTheDocument();

    // Stopped / Not running: hollow dot
    spy.mockResolvedValue(mockStatus("stopped", "rust"));
    useWorkspaceStore.setState({ activeFilePath: "stopped.rs" });
    rerender(<LspStatusRow api={{}} worktreeId="wt-1" />);
    expect(await screen.findByRole("button", { name: /Rust.*Not running/ })).toBeInTheDocument();
    expect(container.querySelector(".lsp-status-row__dot--off")).toBeInTheDocument();

    // Disabled / Off: trigger reads 'LSP off'
    spy.mockResolvedValue(mockStatus("disabled", "rust"));
    useWorkspaceStore.setState({ activeFilePath: "disabled.rs" });
    rerender(<LspStatusRow api={{}} worktreeId="wt-1" />);
    expect(await screen.findByRole("button", { name: "LSP off" })).toBeInTheDocument();
    expect(container.querySelector(".lsp-status-row__dot--off")).toBeInTheDocument();

    // Not found / Not installed: warn dot
    spy.mockResolvedValue(mockStatus("not_found", "rust"));
    useWorkspaceStore.setState({ activeFilePath: "notfound.rs" });
    rerender(<LspStatusRow api={{}} worktreeId="wt-1" />);
    expect(await screen.findByRole("button", { name: /Rust.*Not installed/ })).toBeInTheDocument();
    expect(container.querySelector(".lsp-status-row__dot--warn")).toBeInTheDocument();

    // Error: error dot
    spy.mockResolvedValue(mockStatus("error", "rust"));
    useWorkspaceStore.setState({ activeFilePath: "error.rs" });
    rerender(<LspStatusRow api={{}} worktreeId="wt-1" />);
    expect(await screen.findByRole("button", { name: /Rust.*Error/ })).toBeInTheDocument();
    expect(container.querySelector(".lsp-status-row__dot--error")).toBeInTheDocument();
  });

  it("hidden when status is unsupported and badge count is 0", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("unsupported", null));
    vi.spyOn(lspApi, "getLspStatuses").mockResolvedValue([]);

    const { container } = render(<LspStatusRow api={{}} worktreeId="wt-1" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("unsupported + badge: trigger shows LSP + badge count and popup has 'No language server for this file type'", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("unsupported", null));
    vi.spyOn(lspApi, "getLspStatuses").mockResolvedValue([mockLangStatus("not_found", "rust")]);

    render(<LspStatusRow api={{}} worktreeId="wt-1" />);

    const trigger = await screen.findByRole("button", { name: /LSP/ });
    expect(trigger).toBeInTheDocument();
    expect(trigger.querySelector(".lsp-status-row__badge")).toHaveTextContent("1");

    fireEvent.click(trigger);
    expect(await screen.findByText("No language server for this file type")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
  });

  it("opens popup on click with header, pill, and sentence (omitted for ready and starting)", async () => {
    const spy = vi.spyOn(lspApi, "getLspStatus");

    // Ready: header & pill, but sentence omitted
    spy.mockResolvedValue(mockStatus("ready", "rust"));
    const { rerender } = render(<LspStatusRow api={{}} worktreeId="wt-1" />);
    const readyTrigger = await screen.findByRole("button", { name: "Rust" });
    fireEvent.click(readyTrigger);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByText("Language server is ready.")).not.toBeInTheDocument();

    // Idle: header, pill, and sentence present
    spy.mockResolvedValue(mockStatus("idle", "rust"));
    useWorkspaceStore.setState({ activeFilePath: "idle.rs" });
    rerender(<LspStatusRow api={{}} worktreeId="wt-1" />);
    const idleTrigger = await screen.findByRole("button", { name: /Rust.*Sleeping/ });
    fireEvent.click(idleTrigger);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Sleeping")).toBeInTheDocument();
    expect(screen.getByText("Wakes when you use code navigation.")).toBeInTheDocument();
  });

  it("clicking the popup's action button resumes a stopped server", async () => {
    const statusSpy = vi
      .spyOn(lspApi, "getLspStatus")
      .mockResolvedValueOnce(mockStatus("stopped", "rust"))
      .mockResolvedValueOnce(mockStatus("starting", "rust"));
    const hoverSpy = vi.spyOn(lspApi, "getHover").mockResolvedValue({ empty: true });

    render(<LspStatusRow api={{}} worktreeId="wt-1" />);

    fireEvent.click(await screen.findByRole("button", { name: /Rust.*Not running/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));

    await waitFor(() => {
      expect(hoverSpy).toHaveBeenCalled();
      expect(statusSpy).toHaveBeenCalledTimes(2);
    });
  });

  it("clicking Turn on enables and chains start (calls setLspEnabled then getHover)", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("disabled", "rust"));
    const setWorktreeLspEnabled = vi.fn().mockResolvedValue({ enabled: true });
    const hoverSpy = vi.spyOn(lspApi, "getHover").mockResolvedValue({ empty: true });

    render(<LspStatusRow api={{ setWorktreeLspEnabled }} worktreeId="wt-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "LSP off" }));
    const turnOnBtn = await screen.findByRole("button", { name: "Turn on" });
    expect(turnOnBtn).toHaveClass("lsp-status-row__btn--primary");
    fireEvent.click(turnOnBtn);

    await waitFor(() => {
      expect(setWorktreeLspEnabled).toHaveBeenCalledWith("wt-1", true);
      expect(hoverSpy).toHaveBeenCalled();
    });
  });

  it("Also in this project: sorted by severity (error, warn, busy, neutral, ok) then name", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("ready", "rust"));
    vi.spyOn(lspApi, "getLspStatuses").mockResolvedValue([
      mockLangStatus("ready", "python"),
      mockLangStatus("error", "go"),
      mockLangStatus("not_found", "typescript"),
      mockLangStatus("starting", "ruby"),
      mockLangStatus("stopped", "c"),
    ]);

    render(<LspStatusRow api={{}} worktreeId="wt-1" />);

    fireEvent.click(await screen.findByRole("button", { name: /Rust/ }));

    await screen.findByText("Also in this project");
    const rows = Array.from(document.querySelectorAll(".lsp-status-row__row-name")).map(
      (el) => el.textContent,
    );
    // Order: Go (error), TypeScript / JavaScript (warn), Ruby (busy), C / C++ (neutral), Python (ok)
    expect(rows).toEqual(["Go", "TypeScript / JavaScript", "Ruby", "C / C++", "Python"]);
  });

  it("clicking a language in Also in this project inspects it in the popup header", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("ready", "rust"));
    vi.spyOn(lspApi, "getLspStatuses").mockResolvedValue([
      mockLangStatus("ready", "rust"),
      mockLangStatus("error", "go"),
    ]);

    render(<LspStatusRow api={{}} worktreeId="wt-1" />);

    fireEvent.click(await screen.findByRole("button", { name: /Rust/ }));
    const goRow = await screen.findByRole("button", { name: /Go.*Error/ });
    fireEvent.click(goRow);

    // Header now reflects Go
    const headerTitle = document.querySelector(".lsp-status-row__title b");
    expect(headerTitle).toHaveTextContent("Go");
  });

  it("Not in this project (N) collapsible section: renders survey languages minus detected, collapsed by default, expands on click", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("ready", "rust"));
    vi.spyOn(lspApi, "getLspStatuses").mockResolvedValue([mockLangStatus("ready", "rust")]);

    const survey: LspLanguageSurveyResponse = {
      languages: [
        {
          language: "rust",
          displayName: "Rust",
          command: "rust-analyzer",
          installedOnHost: true,
          installCommand: null,
          installNote: null,
        },
        {
          language: "python",
          displayName: "Python",
          command: "pyright",
          installedOnHost: true,
          installCommand: null,
          installNote: null,
        },
      ],
    };
    const mockClient = { getLspLanguages: vi.fn().mockResolvedValue(survey) };

    render(<LspStatusRow api={mockClient} worktreeId="wt-1" />);

    fireEvent.click(await screen.findByRole("button", { name: /Rust/ }));

    const toggle = await screen.findByRole("button", { name: /Not in this project \(1\)/ });
    expect(toggle).toBeInTheDocument();
    expect(screen.queryByText("Python")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(await screen.findByText("Python")).toBeInTheDocument();
    expect(screen.getByText("Installed")).toBeInTheDocument();
  });

  it("shows skeleton rows while per-language breakdown is in flight", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("ready", "rust"));
    let resolveStatuses: (v: lspApi.LspLanguageStatus[]) => void = () => {};
    vi.spyOn(lspApi, "getLspStatuses").mockReturnValue(
      new Promise((resolve) => {
        resolveStatuses = resolve;
      }),
    );

    const { container } = render(<LspStatusRow api={{}} worktreeId="wt-1" />);

    fireEvent.click(await screen.findByRole("button", { name: /Rust/ }));
    expect(container.querySelectorAll(".lsp-status-row__skel").length).toBeGreaterThan(0);

    resolveStatuses([mockLangStatus("ready", "rust")]);
    await waitFor(() => expect(container.querySelectorAll(".lsp-status-row__skel").length).toBe(0));
  });

  it("list-load error row renders Couldn't load languages. with Retry button", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("ready", "rust"));
    const statusesSpy = vi.spyOn(lspApi, "getLspStatuses").mockRejectedValue(new Error("network error"));

    render(<LspStatusRow api={{}} worktreeId="wt-1" />);

    fireEvent.click(await screen.findByRole("button", { name: /Rust/ }));
    expect(await screen.findByText(/Couldn['’]t load languages\./)).toBeInTheDocument();

    statusesSpy.mockResolvedValueOnce([mockLangStatus("ready", "rust")]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.queryByText(/Couldn['’]t load languages\./)).not.toBeInTheDocument();
    });
  });

  it("Esc key closes popup and returns focus to trigger", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("ready", "rust"));

    render(<LspStatusRow api={{}} worktreeId="wt-1" />);

    const trigger = await screen.findByRole("button", { name: "Rust" });
    fireEvent.click(trigger);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });

  describe("latched failure (missing dependency)", () => {
    const command = 'npm i -D "typescript@<7"';
    const failure: LspFailure = {
      kind: "missing_dependency",
      summary: "TypeScript isn't installed for this project — code navigation needs it.",
      message: "Request initialize failed with message: Could not find a valid TypeScript installation.",
      remediation: [
        { kind: "copy_command", label: "Copy install command", command },
        { kind: "retry", label: "Check again" },
      ],
      autoRetry: true,
    };
    const failed: LspStatusResponse = {
      status: "error",
      language: "typescript",
      label: "Setup needed",
      displayName: "TypeScript / JavaScript",
      severity: "warn",
      detail: failure.summary,
      action: "retry",
      actionLabel: "Check again",
      failure,
    };

    beforeEach(() => {
      useWorkspaceStore.setState({ activeFilePath: "src/a.ts" });
    });

    it("renders Setup needed with a yellow dot and the summary as tooltip", async () => {
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(failed);
      const { container } = render(<LspStatusRow api={{}} worktreeId="wt-1" />);
      const trigger = await screen.findByRole("button", { name: /TypeScript.*Setup needed/ });
      expect(trigger).toHaveAttribute("title", failure.summary);
      expect(container.querySelector(".lsp-status-row__dot--warn")).toBeInTheDocument();
    });

    it("popup: detail, inline command, Check again button, Show output disclosure", async () => {
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(failed);
      render(<LspStatusRow api={{}} worktreeId="wt-1" />);

      fireEvent.click(await screen.findByRole("button", { name: /TypeScript.*Setup needed/ }));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent(failure.summary);
      expect(dialog.querySelector("code")).toHaveTextContent(command);
      expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
      expect(screen.getByText("Show output")).toBeInTheDocument();
      expect(dialog.querySelector("pre")).toHaveTextContent("Could not find a valid TypeScript installation");
    });

    it("Copy install command writes the daemon's command and reads Copied", async () => {
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(failed);
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

      render(<LspStatusRow api={{}} worktreeId="wt-1" />);

      fireEvent.click(await screen.findByRole("button", { name: /TypeScript.*Setup needed/ }));
      fireEvent.click(await screen.findByRole("button", { name: "Copy install command" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(command));
      expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    });

    it("Check again calls restartLsp for the server's language", async () => {
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(failed);
      const restart = vi.spyOn(lspApi, "restartLsp").mockResolvedValue({ ...failed, failure: null });

      render(<LspStatusRow api={{}} worktreeId="wt-1" />);

      fireEvent.click(await screen.findByRole("button", { name: /TypeScript.*Setup needed/ }));
      fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
      await waitFor(() => expect(restart).toHaveBeenCalledWith({}, "worktree", "wt-1", "typescript"));
    });

    it("an info-level note stays green and appears in tooltip and popup", async () => {
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
        ...mockStatus("ready", "typescript"),
        degraded: { message: "Using TypeScript 5.9.3 (global) — workspace TypeScript 7.0.2 has no tsserver.", level: "info" },
      });

      const { container } = render(<LspStatusRow api={{}} worktreeId="wt-1" />);

      const trigger = await screen.findByRole("button", { name: "TypeScript" });
      expect(trigger.getAttribute("title")).toContain("Using TypeScript 5.9.3 (global)");
      expect(container.querySelector(".lsp-status-row__dot--ok")).toBeInTheDocument();

      fireEvent.click(trigger);
      expect(await screen.findByRole("dialog")).toHaveTextContent("Using TypeScript 5.9.3 (global)");
    });

    it("ready + degraded renders Limited in trigger and header with warn note", async () => {
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
        ...mockStatus("ready", "typescript"),
        degraded: { message: "Some compiler options not supported.", level: "warning" },
      });

      const { container } = render(<LspStatusRow api={{}} worktreeId="wt-1" />);

      const trigger = await screen.findByRole("button", { name: /TypeScript.*Limited/ });
      expect(trigger).toBeInTheDocument();
      expect(container.querySelector(".lsp-status-row__dot--warn")).toBeInTheDocument();

      fireEvent.click(trigger);
      expect(await screen.findByRole("dialog")).toHaveTextContent("Some compiler options not supported.");
      expect(screen.getByText("Limited")).toBeInTheDocument();
    });
  });

  describe("review fixes", () => {
    it("auto-restarting crash (Restarting) offers no action button", async () => {
      const failure: LspFailure = {
        kind: "crashed",
        summary: "rust-analyzer stopped unexpectedly — restarting (attempt 1 of 3).",
        message: "boom",
        remediation: [{ kind: "retry", label: "Restart" }],
        autoRetry: true,
      };
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
        status: "error",
        language: "rust",
        label: "Restarting",
        displayName: "Rust",
        severity: "warn",
        detail: failure.summary,
        action: null,
        actionLabel: null,
        failure,
      });

      render(<LspStatusRow api={{}} worktreeId="wt-1" />);
      fireEvent.click(await screen.findByRole("button", { name: /Rust/ }));

      const dialog = await screen.findByRole("dialog");
      expect(dialog.querySelector(".lsp-status-row__actions")).toBeNull();
      expect(within(dialog).queryByRole("button", { name: /Restart|Retry/ })).not.toBeInTheDocument();
    });

    it("drilling into another language leaves the trigger describing the current file", async () => {
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("ready", "rust"));
      vi.spyOn(lspApi, "getLspStatuses").mockResolvedValue([
        mockLangStatus("ready", "rust"),
        mockLangStatus("not_found", "python"),
      ]);

      const { container } = render(<LspStatusRow api={{}} worktreeId="wt-1" />);
      const trigger = await screen.findByRole("button", { name: /^Rust/ });
      fireEvent.click(trigger);
      fireEvent.click(await screen.findByRole("button", { name: /Python/ }));

      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("Not installed", { selector: ".lsp-status-row__pill" })).toBeInTheDocument();
      // Trigger unchanged: still "Rust", no state word, still green.
      expect(trigger).toHaveTextContent(/^Rust/);
      expect(trigger).not.toHaveTextContent(/Not installed/);
      expect(container.querySelector(".lsp-status-row__trigger .lsp-status-row__state")).toBeNull();
    });

    it("a drilled-in stopped language shows no resume/enable button", async () => {
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("ready", "rust"));
      vi.spyOn(lspApi, "getLspStatuses").mockResolvedValue([
        mockLangStatus("ready", "rust"),
        mockLangStatus("stopped", "python"),
      ]);

      render(<LspStatusRow api={{}} worktreeId="wt-1" />);
      fireEvent.click(await screen.findByRole("button", { name: /^Rust/ }));
      fireEvent.click(await screen.findByRole("button", { name: /Python/ }));

      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    });

    it("busy languages do not count toward the attention badge", async () => {
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("ready", "rust"));
      vi.spyOn(lspApi, "getLspStatuses").mockResolvedValue([
        mockLangStatus("ready", "rust"),
        mockLangStatus("indexing", "typescript"),
      ]);

      const { container } = render(<LspStatusRow api={{}} worktreeId="wt-1" />);
      await screen.findByRole("button", { name: /^Rust/ });
      await waitFor(() => expect(lspApi.getLspStatuses).toHaveBeenCalled());
      expect(container.querySelector(".lsp-status-row__badge")).toBeNull();
    });

    it("drill-in selection is forgotten when the popup closes", async () => {
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("ready", "rust"));
      vi.spyOn(lspApi, "getLspStatuses").mockResolvedValue([
        mockLangStatus("ready", "rust"),
        mockLangStatus("not_found", "python"),
      ]);

      render(<LspStatusRow api={{}} worktreeId="wt-1" />);
      const trigger = await screen.findByRole("button", { name: /^Rust/ });
      fireEvent.click(trigger);
      fireEvent.click(await screen.findByRole("button", { name: /Python/ }));
      expect(within(await screen.findByRole("dialog")).getByText("Python")).toBeInTheDocument();

      fireEvent.click(trigger); // close
      fireEvent.click(trigger); // reopen
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByRole("heading", { level: 4 })).toHaveTextContent("Also in this project");
      expect(dialog.querySelector(".lsp-status-row__title b")).toHaveTextContent("Rust");
    });

    it("unsupported file + drilled-in Restart keeps the popup open when the badge drops to 0", async () => {
      vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("unsupported", null));
      const crashed = mockLangStatus("error", "python", {
        label: "Failed to start",
        action: "retry",
        actionLabel: "Restart",
      });
      const statusesSpy = vi.spyOn(lspApi, "getLspStatuses").mockResolvedValue([crashed]);
      const restart = vi.spyOn(lspApi, "restartLsp").mockResolvedValue(mockStatus("starting", "python"));

      render(<LspStatusRow api={{}} worktreeId="wt-1" />);
      fireEvent.click(await screen.findByRole("button", { name: /^LSP/ }));
      fireEvent.click(await screen.findByRole("button", { name: /Python/ }));

      statusesSpy.mockResolvedValue([mockLangStatus("starting", "python")]);
      fireEvent.click(await screen.findByRole("button", { name: "Restart" }));

      await waitFor(() => expect(restart).toHaveBeenCalledWith(expect.anything(), "worktree", "wt-1", "python"));
      // Badge is now 0, but the row must not unmount from under the user.
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });

    it("refreshes the language list on the status poll heartbeat while the popup is open", async () => {
      vi.useFakeTimers();
      try {
        vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("ready", "rust"));
        const statusesSpy = vi.spyOn(lspApi, "getLspStatuses").mockResolvedValue([mockLangStatus("ready", "rust")]);

        render(<LspStatusRow api={{}} worktreeId="wt-1" />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10);
        });
        fireEvent.click(screen.getByRole("button", { name: /^Rust/ }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10);
        });
        const before = statusesSpy.mock.calls.length;

        await act(async () => {
          await vi.advanceTimersByTimeAsync(5100);
        });
        expect(statusesSpy.mock.calls.length).toBeGreaterThan(before);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a failed heartbeat keeps the already-loaded language list instead of an error row", async () => {
      vi.useFakeTimers();
      try {
        vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mockStatus("ready", "rust"));
        const statusesSpy = vi
          .spyOn(lspApi, "getLspStatuses")
          .mockResolvedValue([mockLangStatus("ready", "rust"), mockLangStatus("stopped", "python")]);

        render(<LspStatusRow api={{}} worktreeId="wt-1" />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10);
        });
        fireEvent.click(screen.getByRole("button", { name: /^Rust/ }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10);
        });
        expect(screen.getByRole("button", { name: /Python/ })).toBeInTheDocument();

        statusesSpy.mockRejectedValue(new Error("blip"));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5100);
        });
        expect(screen.getByRole("button", { name: /Python/ })).toBeInTheDocument();
        expect(screen.queryByText(/Couldn['’]t load languages\./)).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
