import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import type { SupportedCli, ValidateAccountPathResponse } from "@/api/types";
import { ApiError } from "@/api/errors";
import { AddAccountDialog } from "./AddAccountDialog";
import { FolderField } from "./FolderField";

const OK: ValidateAccountPathResponse = { dir: "~/.claude-work", exists: true, isEmpty: false, looksValid: true };

function cliWith(fieldNote: string | null = null): SupportedCli {
  return {
    id: "claude",
    defaultModel: "sonnet",
    supportsJson: true,
    supportsTerminalDelivery: false,
    supportsTerminalComments: false,
    accountLink: {
      fieldLabel: "Claude config folder",
      fieldNote,
      exampleDir: "~/.claude-work",
      systemDir: "~/.claude",
      supportsApiKey: true,
      verifiesIdentity: true,
    },
  } as unknown as SupportedCli;
}

function stubApi(over: Partial<Record<"validateAccountPath" | "fsComplete", unknown>> = {}) {
  return {
    validateAccountPath: vi.fn(async () => OK),
    fsComplete: vi.fn(async () => ({ base: "~/", entries: [], truncated: false })),
    ...over,
  } as unknown as ApiInstance & { validateAccountPath: ReturnType<typeof vi.fn> };
}

/** Controlled wrapper so typing and picks update the field like the real form. */
function Harness({
  api,
  cli,
  onValid = () => undefined,
}: {
  api: ApiInstance;
  cli: SupportedCli;
  onValid?: (r: ValidateAccountPathResponse | null) => void;
}) {
  const [value, setValue] = useState("");
  return <FolderField api={api} cli={cli} value={value} onChange={setValue} onValid={onValid} error="" />;
}

function inputOf() {
  return screen.getByLabelText("Claude config folder") as HTMLInputElement;
}

describe("FolderField", () => {
  it("shows_label_and_placeholder_from_account_link", () => {
    render(<Harness api={stubApi()} cli={cliWith()} />);
    expect(inputOf()).toHaveAttribute("placeholder", "~/.claude-work");
  });

  it("validate_error_text_is_shown_and_reported", async () => {
    const api = stubApi({
      validateAccountPath: vi.fn(async () => {
        throw new ApiError(JSON.stringify({ error: "Folder not found.", code: "folder_not_found" }), 404, "folder_not_found");
      }),
    });
    const onValid = vi.fn();
    render(<Harness api={api} cli={cliWith()} onValid={onValid} />);
    fireEvent.change(inputOf(), { target: { value: "~/nope" } });
    fireEvent.blur(inputOf());
    expect(await screen.findByRole("alert")).toHaveTextContent("Folder not found.");
    await waitFor(() => expect(onValid).toHaveBeenLastCalledWith(null));
  });

  it("editing_reports_unchecked_until_the_new_check_lands", async () => {
    vi.useFakeTimers();
    try {
      const onValid = vi.fn();
      render(<Harness api={stubApi()} cli={cliWith()} onValid={onValid} />);
      fireEvent.change(inputOf(), { target: { value: "~/.claude-work" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(onValid).toHaveBeenLastCalledWith(OK);
      fireEvent.change(inputOf(), { target: { value: "~/.claude-work2" } });
      expect(onValid).toHaveBeenLastCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ok_shows_folder_exists_tick", async () => {
    const onValid = vi.fn();
    render(<Harness api={stubApi()} cli={cliWith()} onValid={onValid} />);
    fireEvent.change(inputOf(), { target: { value: "~/.claude-work" } });
    expect(await screen.findByText("✓ Folder exists")).toBeInTheDocument();
    expect(onValid).toHaveBeenLastCalledWith(OK);
  });

  it("looks_invalid_note_is_not_blocking", async () => {
    const api = stubApi({
      validateAccountPath: vi.fn(async () => ({ ...OK, looksValid: false })),
    });
    render(<Harness api={api} cli={cliWith()} />);
    fireEvent.change(inputOf(), { target: { value: "~/.claude-work" } });
    expect(
      await screen.findByText("This does not look like a Claude config folder; sign-in will fill it."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("field_note_shown_when_present_and_absent_otherwise", () => {
    const { unmount } = render(<Harness api={stubApi()} cli={cliWith("Hides ~/.config/gh.")} />);
    expect(screen.getByText("Hides ~/.config/gh.")).toBeInTheDocument();
    unmount();
    render(<Harness api={stubApi()} cli={cliWith(null)} />);
    expect(screen.queryByText("Hides ~/.config/gh.")).toBeNull();
    expect(document.querySelector(".accounts-folder-field__help")).toBeNull();
  });

  it("browse_opens_chooser_and_fills_value", async () => {
    const api = stubApi({
      fsComplete: vi.fn(async () => ({ base: "~/code/", entries: [], truncated: false })),
    });
    render(<Harness api={api} cli={cliWith()} />);
    fireEvent.change(inputOf(), { target: { value: "~/code" } });
    // Browse opens on the folder itself once the check found it.
    await screen.findByText("✓ Folder exists");
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Select Folder" }));
    await waitFor(() => expect(inputOf().value).toBe("~/code"));
  });

  it("browse_pick_does_not_open_the_list", async () => {
    const api = stubApi({
      fsComplete: vi.fn(async () => ({ base: "~/", entries: [{ name: "code", path: "~/code" }], truncated: false })),
    });
    render(<Harness api={api} cli={cliWith()} />);
    fireEvent.change(inputOf(), { target: { value: "~/code" } });
    // Browse opens on the folder itself once the check found it.
    await screen.findByText("✓ Folder exists");
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Select Folder" }));
    await waitFor(() => expect(inputOf().value).toBe("~/code"));
    await waitFor(() => expect(api.fsComplete).toHaveBeenCalled());
    expect(screen.queryByRole("listbox", { name: "Folder suggestions" })).toBeNull();
    expect(inputOf()).toHaveAttribute("aria-expanded", "false");
  });

  it("completion_pick_sets_value_with_slash", async () => {
    const api = stubApi({
      fsComplete: vi.fn(async () => ({ base: "~/", entries: [{ name: "work", path: "~/work" }], truncated: false })),
    });
    render(<Harness api={api} cli={cliWith()} />);
    fireEvent.focus(inputOf());
    fireEvent.change(inputOf(), { target: { value: "~/w" } });
    fireEvent.click(await screen.findByRole("option", { name: "work/" }));
    expect(inputOf().value).toBe("~/work/");
  });

  describe("keyboard and combobox", () => {
    const ENTRIES = [
      { name: "projects", path: "~/projects" },
      { name: "public", path: "~/public" },
    ];
    const listApi = () =>
      stubApi({ fsComplete: vi.fn(async () => ({ base: "~/", entries: ENTRIES, truncated: false })) });

    async function typeP() {
      fireEvent.focus(inputOf());
      fireEvent.change(inputOf(), { target: { value: "~/p" } });
      await screen.findByRole("listbox");
    }

    it("arrow_down_highlights_first_and_wraps_focus_stays_in_input", async () => {
      render(<Harness api={listApi()} cli={cliWith()} />);
      inputOf().focus();
      await typeP();
      fireEvent.keyDown(inputOf(), { key: "ArrowDown" });
      const options = screen.getAllByRole("option");
      expect(options[0]).toHaveAttribute("aria-selected", "true");
      fireEvent.keyDown(inputOf(), { key: "ArrowDown" });
      fireEvent.keyDown(inputOf(), { key: "ArrowDown" });
      expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
      fireEvent.keyDown(inputOf(), { key: "ArrowUp" });
      expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
      expect(document.activeElement).toBe(inputOf());
    });

    it("enter_accepts_highlight_with_trailing_slash_and_does_not_submit", async () => {
      render(<Harness api={listApi()} cli={cliWith()} />);
      await typeP();
      fireEvent.keyDown(inputOf(), { key: "ArrowDown" });
      const notPrevented = fireEvent.keyDown(inputOf(), { key: "Enter" });
      expect(notPrevented).toBe(false);
      expect(inputOf().value).toBe("~/projects/");
    });

    it("enter_without_highlight_is_left_alone", async () => {
      render(<Harness api={listApi()} cli={cliWith()} />);
      await typeP();
      expect(fireEvent.keyDown(inputOf(), { key: "Enter" })).toBe(true);
      expect(inputOf().value).toBe("~/p");
    });

    it("tab_accepts_first_completion_and_is_not_trapped_without_one", async () => {
      render(<Harness api={listApi()} cli={cliWith()} />);
      await typeP();
      expect(fireEvent.keyDown(inputOf(), { key: "Tab" })).toBe(false);
      expect(inputOf().value).toBe("~/projects/");
      // The new folder has no listed children for this text, so Tab moves focus normally.
      fireEvent.change(inputOf(), { target: { value: "" } });
      expect(fireEvent.keyDown(inputOf(), { key: "Tab" })).toBe(true);
    });

    it("arrow_right_at_caret_end_accepts", async () => {
      render(<Harness api={listApi()} cli={cliWith()} />);
      await typeP();
      inputOf().setSelectionRange(3, 3);
      expect(fireEvent.keyDown(inputOf(), { key: "ArrowRight" })).toBe(false);
      expect(inputOf().value).toBe("~/projects/");
    });

    it("escape_closes_only_the_list", async () => {
      const api = stubApi({
        fsComplete: vi.fn(async () => ({ base: "~/", entries: ENTRIES, truncated: false })),
      });
      const onClose = vi.fn();
      render(<AddAccountDialog open api={api} cli={cliWith()} onClose={onClose} initialDir="" />);
      fireEvent.click(screen.getByRole("radio", { name: "Choose a folder" }));
      fireEvent.focus(inputOf());
      fireEvent.change(inputOf(), { target: { value: "~/p" } });
      await screen.findByRole("listbox");
      fireEvent.keyDown(inputOf(), { key: "Escape" });
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByText(/Add .* account/)).toBeInTheDocument();
      fireEvent.keyDown(inputOf(), { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("ghost_remainder_is_drawn_while_focused_and_gone_after_blur_or_trailing_slash", async () => {
      render(<Harness api={listApi()} cli={cliWith()} />);
      await typeP();
      expect(document.querySelector(".path-ghost")?.textContent).toBe("~/projects/");
      expect(document.querySelector(".path-ghost__typed")?.textContent).toBe("~/p");
      fireEvent.blur(inputOf());
      expect(document.querySelector(".path-ghost")).toBeNull();
      fireEvent.focus(inputOf());
      fireEvent.change(inputOf(), { target: { value: "~/projects/" } });
      expect(document.querySelector(".path-ghost")).toBeNull();
    });

    it("ghost_stays_after_escape_closes_the_list_and_tab_still_accepts", async () => {
      render(<Harness api={listApi()} cli={cliWith()} />);
      await typeP();
      fireEvent.keyDown(inputOf(), { key: "Escape" });
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(document.querySelector(".path-ghost")?.textContent).toBe("~/projects/");
      expect(fireEvent.keyDown(inputOf(), { key: "Tab" })).toBe(false);
      expect(inputOf().value).toBe("~/projects/");
    });

    it("a_clipped_ghost_is_not_accepted_by_tab", async () => {
      const sw = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(300);
      const cw = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(200);
      try {
        render(<Harness api={listApi()} cli={cliWith()} />);
        await typeP();
        expect(document.querySelector<HTMLElement>(".path-ghost__track")?.style.visibility).toBe("hidden");
        expect(fireEvent.keyDown(inputOf(), { key: "Tab" })).toBe(true);
        expect(inputOf().value).toBe("~/p");
      } finally {
        sw.mockRestore();
        cw.mockRestore();
      }
    });

    it("a_failed_completion_fetch_is_shown_as_muted_text", async () => {
      const api = stubApi({
        fsComplete: vi.fn(async () => {
          throw new Error("boom");
        }),
      });
      render(<Harness api={api} cli={cliWith()} />);
      fireEvent.focus(inputOf());
      fireEvent.change(inputOf(), { target: { value: "~/p" } });
      expect(await screen.findByText("Failed to fetch directory suggestions")).toHaveClass("path-ghost-note");
      expect(document.querySelector(".path-ghost")).toBeNull();
    });

    it("stale_list_is_not_shown_for_a_new_folder", async () => {
      render(<Harness api={listApi()} cli={cliWith()} />);
      await typeP();
      fireEvent.change(inputOf(), { target: { value: "~/projects/x" } });
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("combobox_roles_and_activedescendant", async () => {
      render(<Harness api={listApi()} cli={cliWith()} />);
      await typeP();
      const input = screen.getByRole("combobox");
      expect(input).toHaveAttribute("aria-expanded", "true");
      expect(input).toHaveAttribute("aria-autocomplete", "both");
      expect(input).toHaveAttribute("aria-controls", screen.getByRole("listbox").id);
      expect(input).not.toHaveAttribute("aria-activedescendant");
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(input).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[0]!.id);
    });
  });

  it("leading_whitespace_is_dropped_as_typed", () => {
    render(<Harness api={stubApi()} cli={cliWith()} />);
    fireEvent.change(inputOf(), { target: { value: "  /tmp" } });
    expect(inputOf().value).toBe("/tmp");
  });

  it("only_one_message_shows_under_the_field", async () => {
    const hard = new ApiError(JSON.stringify({ error: "Nope.", code: "folder_is_system" }), 409, "folder_is_system");
    const api = stubApi({
      fsComplete: vi.fn(async () => {
        throw new Error("boom");
      }),
      validateAccountPath: vi.fn(async () => {
        throw hard;
      }),
    });
    render(<Harness api={api} cli={cliWith()} />);
    fireEvent.focus(inputOf());
    fireEvent.change(inputOf(), { target: { value: "foo" } });
    expect(await screen.findByText("Failed to fetch directory suggestions")).toHaveClass("path-ghost-note");
    expect(await screen.findByRole("alert")).toHaveTextContent("Nope.");
    expect(document.querySelector(".path-ghost-note")).toBeNull();
  });

  describe("unfinished paths", () => {
    const notFound = () =>
      stubApi({
        validateAccountPath: vi.fn(async () => {
          throw new ApiError(JSON.stringify({ error: "Folder not found.", code: "folder_not_found" }), 404, "folder_not_found");
        }),
      });

    it("not_found_is_not_an_error_while_focused", async () => {
      const api = notFound();
      const onValid = vi.fn();
      render(<Harness api={api} cli={cliWith()} onValid={onValid} />);
      fireEvent.focus(inputOf());
      fireEvent.change(inputOf(), { target: { value: "~/p" } });
      await waitFor(() => expect(api.validateAccountPath).toHaveBeenCalled());
      await waitFor(() => expect(onValid).toHaveBeenLastCalledWith(null));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(inputOf()).not.toHaveAttribute("aria-invalid");
    });

    it("not_found_shows_after_blur", async () => {
      render(<Harness api={notFound()} cli={cliWith()} />);
      fireEvent.focus(inputOf());
      fireEvent.change(inputOf(), { target: { value: "~/p" } });
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      await new Promise((r) => setTimeout(r, 400));
      fireEvent.blur(inputOf());
      expect(await screen.findByRole("alert")).toHaveTextContent("Folder not found.");
      expect(inputOf()).toHaveAttribute("aria-invalid", "true");
    });

    it("system_folder_refusal_shows_immediately_while_focused", async () => {
      const api = stubApi({
        validateAccountPath: vi.fn(async () => {
          throw new ApiError(JSON.stringify({ error: "That is the system login folder.", code: "folder_is_system" }), 409, "folder_is_system");
        }),
      });
      render(<Harness api={api} cli={cliWith()} />);
      fireEvent.focus(inputOf());
      fireEvent.change(inputOf(), { target: { value: "~/.claude" } });
      expect(await screen.findByRole("alert")).toHaveTextContent("system login folder");
    });
  });
});
