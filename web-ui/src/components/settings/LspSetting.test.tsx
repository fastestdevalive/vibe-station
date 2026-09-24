import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { LspLanguageSurveyEntry } from "@/api/types";
import { createMockApi } from "@/api/mock";
import { LspSetting } from "./LspSetting";

const FIXTURE: LspLanguageSurveyEntry[] = [
  { language: "rust", displayName: "Rust", command: "rust-analyzer", installedOnHost: true, installCommand: null, installNote: null },
  { language: "go", displayName: "Go", command: "gopls", installedOnHost: true, installCommand: null, installNote: null },
  { language: "python", displayName: "Python", command: "pyright-langserver", installedOnHost: false, installCommand: "npm install -g pyright", installNote: null },
  { language: "cpp", displayName: "C / C++", command: "clangd", installedOnHost: false, installCommand: null, installNote: "Debian/Ubuntu: apt install clangd" },
  { language: "latex", displayName: "LaTeX", command: "texlab", installedOnHost: false, installCommand: "cargo install texlab", installNote: "macOS alternative: brew install texlab" },
];

function renderLoaded(languages: LspLanguageSurveyEntry[] = FIXTURE) {
  const api = createMockApi();
  const spy = vi.spyOn(api, "getLspLanguages").mockResolvedValue({ languages });
  render(<LspSetting api={api} />);
  return { api, spy };
}

describe("LspSetting", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders all languages with correct badges, copy buttons, and notes", async () => {
    renderLoaded();

    for (const entry of FIXTURE) {
      await waitFor(() => {
        expect(screen.getByText(entry.displayName)).toBeInTheDocument();
      });
    }

    expect(screen.getAllByText("Installed")).toHaveLength(2);
    expect(screen.getAllByText("Missing")).toHaveLength(3);

    const copyButtons = screen.getAllByRole("button", { name: "Copy" });
    const withCommand = FIXTURE.filter((e) => e.installedOnHost === false && e.installCommand !== null);
    expect(copyButtons).toHaveLength(withCommand.length);

    const withNote = FIXTURE.filter((e) => e.installedOnHost === false && e.installNote !== null);
    for (const entry of withNote) {
      expect(screen.getByText(entry.installNote as string)).toBeInTheDocument();
    }

    for (const entry of withCommand) {
      expect(screen.getByText(entry.installCommand as string)).toBeInTheDocument();
    }
  });

  it("shows an error state instead of zero rows when the fetch rejects", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getLspLanguages").mockRejectedValue(new Error("boom"));
    render(<LspSetting api={api} />);

    await waitFor(() => {
      expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
    });
    expect(screen.queryByText("Rust")).toBeNull();
    expect(screen.queryAllByRole("button", { name: "Copy" })).toHaveLength(0);
  });

  it("copies the exact install command and flips the button to Copied", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });

    renderLoaded();

    const target = FIXTURE.find((e) => e.installedOnHost === false && e.installCommand !== null)!;
    // Locate the Copy button on the row whose install command matches, so the
    // assertion is exact even when multiple Copy buttons are on screen.
    const commandEl = await screen.findByText(target.installCommand as string);
    const copyButton = commandEl.closest("div")?.querySelector("button");
    expect(copyButton).not.toBeNull();

    await user.click(copyButton!);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(target.installCommand);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    });
  });
});
