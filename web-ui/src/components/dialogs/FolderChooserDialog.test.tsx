import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { Dialog } from "./Dialog";
import { FolderChooserDialog } from "./FolderChooserDialog";

/**
 * MOCK_HOME = "/home/user", MOCK_FS_TREE:
 *   /home/user                    -> projects, code, work
 *   /home/user/projects           -> proj-a, proj-b
 *   /home/user/code               -> fastestdevalive, Fast-notes, other, .cache
 *   /home/user/code/fastestdevalive -> vibe-station
 */
function inputOf(): HTMLInputElement {
  return screen.getByPlaceholderText(/Type path/i) as HTMLInputElement;
}
describe("FolderChooserDialog", () => {
  it("lists_the_initial_paths_children_on_open", async () => {
    const api = createMockApi();
    render(
      <FolderChooserDialog
        open
        onClose={() => {}}
        onSelect={() => {}}
        api={api}
        initialPath="/home/user"
      />,
    );
    await screen.findByText("code");
    expect(screen.getByText("projects")).toBeInTheDocument();
    expect(screen.getByText("work")).toBeInTheDocument();
  });

  it("double_click_descends", async () => {
    const api = createMockApi();
    render(
      <FolderChooserDialog
        open
        onClose={() => {}}
        onSelect={() => {}}
        api={api}
        initialPath="/home/user"
      />,
    );
    const projects = await screen.findByText("projects");
    await userEvent.dblClick(projects);
    await screen.findByText("proj-a");
    expect(screen.getByText("proj-b")).toBeInTheDocument();
    // Navigated paths carry their own trailing slash.
    expect(screen.getByDisplayValue("/home/user/projects/")).toBeInTheDocument();
  });

  it("keyboard: ArrowDown highlights in the field, ArrowRight accepts, Backspace only edits text", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(
      <FolderChooserDialog
        open
        onClose={() => {}}
        onSelect={() => {}}
        api={api}
        initialPath="/home/user"
      />,
    );
    await screen.findByText("code");
    const input = inputOf();
    input.focus();

    // Alphabetical order: code, projects, work.
    await user.keyboard("{ArrowDown}{ArrowDown}"); // code -> projects
    expect(input).toHaveFocus();
    await user.keyboard("{ArrowRight}"); // caret at end: accept the highlight
    await screen.findByText("proj-a");
    expect(inputOf()).toHaveValue("/home/user/projects/");

    await user.keyboard("{Backspace}"); // plain text editing, no navigation
    expect(inputOf()).toHaveValue("/home/user/projects");
    expect(screen.getByText("proj-a")).toBeInTheDocument();
  });

  it("count_is_singular_for_one_folder", async () => {
    const api = createMockApi();
    api.fsComplete = vi.fn(async () => ({ base: "/home/user", entries: [{ name: "only", path: "/home/user/only" }], truncated: false })) as typeof api.fsComplete;
    render(<FolderChooserDialog open onClose={() => {}} onSelect={() => {}} api={api} initialPath="/home/user" />);
    expect(await screen.findByText("1 folder")).toBeInTheDocument();
  });

  it("up_button_noop_at_root", async () => {
    const api = createMockApi();
    render(
      <FolderChooserDialog open onClose={() => {}} onSelect={() => {}} api={api} initialPath="/" />,
    );
    // Accessible name comes from the button's text content ("↱ Up") — the
    // "Go to parent directory" string is only the `title` tooltip.
    await waitFor(() => expect(screen.getByRole("button", { name: /Up/i })).toBeDisabled());
  });

  it("select_folder_calls_onSelect_with_current_path", async () => {
    const api = createMockApi();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <FolderChooserDialog
        open
        onClose={onClose}
        onSelect={onSelect}
        api={api}
        initialPath="/home/user/projects"
      />,
    );
    await screen.findByText("proj-a");
    await userEvent.click(screen.getByRole("button", { name: /^Select Folder$/i }));
    expect(onSelect).toHaveBeenCalledWith("/home/user/projects");
    expect(onClose).toHaveBeenCalled();
  });

  // D4 — the chooser is opened as a SECOND, nested Dialog from within a host
  // dialog (mirrors how NewAgentDialog renders it: FolderChooserDialog is
  // always mounted with open=false, then flips to open=true on a later
  // render in response to the Browse click — never open on the very first
  // render alongside the host). Escape must close only the topmost (chooser)
  // dialog, not both.
  it("escape_closes_only_inner_dialog", async () => {
    const api = createMockApi();
    const outerClose = vi.fn();
    const innerClose = vi.fn();

    function Harness() {
      const [chooserOpen, setChooserOpen] = useState(false);
      return (
        <Dialog open title="New Agent" onClose={outerClose}>
          <p>host dialog body</p>
          <button type="button" onClick={() => setChooserOpen(true)}>
            open chooser
          </button>
          <FolderChooserDialog
            open={chooserOpen}
            onClose={() => {
              innerClose();
              setChooserOpen(false);
            }}
            onSelect={() => {}}
            api={api}
            initialPath="/home/user"
          />
        </Dialog>
      );
    }
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: /open chooser/i }));
    await screen.findByText("code"); // chooser content mounted

    await userEvent.keyboard("{Escape}");

    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();
  });

  it("keeps focus in the path field while typing a path with listable children", async () => {
    // Regression, caught in the sandbox: an effect focused the list container
    // whenever results arrived. Because typing triggers the fetch, focus was
    // stolen mid-word and every character after the first went to the listbox —
    // "/home/user" + "/proj" recorded only the slash.
    const api = createMockApi();
    render(
      <FolderChooserDialog
        open
        onClose={() => {}}
        onSelect={() => {}}
        api={api}
        initialPath="/home/user"
      />,
    );
    await screen.findByText("projects"); // initial listing resolved

    const pathInput = screen.getByPlaceholderText(/Type path/i);
    await userEvent.clear(pathInput);
    await userEvent.type(pathInput, "/home/user/projects/");

    // Every character landed, and focus never left the field.
    await waitFor(() => expect(pathInput).toHaveValue("/home/user/projects/"));
    expect(pathInput).toHaveFocus();
    // …and the debounced fetch still followed the typed path.
    await screen.findByText("proj-a");
  });

  it("typing_a_prefix_lists_matches_without_slash", async () => {
    const api = createMockApi();
    render(<FolderChooserDialog open onClose={() => {}} onSelect={() => {}} api={api} initialPath="/home/user/code/" />);
    await screen.findByText("fastestdevalive");
    await userEvent.clear(inputOf());
    await userEvent.type(inputOf(), "/home/user/code/faste");
    await waitFor(() => expect(screen.queryByText("other")).toBeNull());
    expect(screen.getByText("fastestdevalive")).toBeInTheDocument();
    expect(screen.queryByText("No matching folders")).toBeNull();
    expect(screen.queryByText("other")).toBeNull();
  });

  it("prefix_is_case_insensitive", async () => {
    const api = createMockApi();
    render(<FolderChooserDialog open onClose={() => {}} onSelect={() => {}} api={api} initialPath="/home/user" />);
    await screen.findByText("code");
    await userEvent.clear(inputOf());
    await userEvent.type(inputOf(), "/home/user/code/FASTE");
    await waitFor(() => expect(screen.queryByText("projects")).toBeNull());
    expect(screen.getByText("fastestdevalive")).toBeInTheDocument();
  });

  it("tilde_prefix_works", async () => {
    const api = createMockApi();
    render(<FolderChooserDialog open onClose={() => {}} onSelect={() => {}} api={api} initialPath="~/" />);
    await screen.findByText("code");
    await userEvent.clear(inputOf());
    await userEvent.type(inputOf(), "~/code/faste");
    await waitFor(() => expect(screen.queryByText("projects")).toBeNull());
    expect(screen.getByText("fastestdevalive")).toBeInTheDocument();
    expect(inputOf()).toHaveValue("~/code/faste");
  });

  it("ghost_shows_remainder_and_right_arrow_accepts", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<FolderChooserDialog open onClose={() => {}} onSelect={() => {}} api={api} initialPath="~/code/" />);
    await screen.findByText("other");
    await user.clear(inputOf());
    await user.type(inputOf(), "~/code/faste");
    await waitFor(() => expect(screen.queryByText("other")).toBeNull());
    // The overlay is the typed text (drawn transparent) plus the muted remainder.
    await waitFor(() =>
      expect(document.querySelector(".path-ghost")?.textContent).toBe("~/code/fastestdevalive/"),
    );
    await user.keyboard("{ArrowRight}");
    expect(inputOf()).toHaveValue("~/code/fastestdevalive/");
  });

  it("ghost_is_hidden_while_the_list_belongs_to_another_folder", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<FolderChooserDialog open onClose={() => {}} onSelect={() => {}} api={api} initialPath="~/code/" />);
    await screen.findByText("other");
    await user.clear(inputOf());
    await user.type(inputOf(), "~/code/faste");
    await waitFor(() => expect(document.querySelector(".path-ghost")).not.toBeNull());
    // Still showing the ~/code/ list while the text now names ~/ (no timers advanced).
    fireEvent.change(inputOf(), { target: { value: "~/faste" } });
    expect(document.querySelector(".path-ghost")).toBeNull();
    expect(fireEvent.keyDown(inputOf(), { key: "Tab" })).toBe(true);
  });

  it("tab_accepts_ghost", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<FolderChooserDialog open onClose={() => {}} onSelect={() => {}} api={api} initialPath="~/code/" />);
    await screen.findByText("other");
    await user.clear(inputOf());
    await user.type(inputOf(), "~/code/faste");
    await waitFor(() => expect(screen.queryByText("other")).toBeNull());
    await user.keyboard("{Tab}");
    expect(inputOf()).toHaveValue("~/code/fastestdevalive/");
  });

  it("tab_without_ghost_is_not_trapped", async () => {
    const api = createMockApi();
    render(<FolderChooserDialog open onClose={() => {}} onSelect={() => {}} api={api} initialPath="/home/user/projects" />);
    await screen.findByText("proj-a");
    // "/home/user/projects/" has an empty last segment: no ghost, no highlight.
    const notPrevented = fireEvent.keyDown(inputOf(), { key: "Tab" });
    expect(notPrevented).toBe(true);
  });

  it("arrow_down_highlights_and_focus_stays_in_input_so_typing_continues", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<FolderChooserDialog open onClose={() => {}} onSelect={() => {}} api={api} initialPath="/home/user" />);
    await screen.findByText("code");
    await user.click(inputOf());
    await user.keyboard("{ArrowDown}");
    const option = screen.getByRole("option", { name: /code/ });
    expect(option).toHaveAttribute("aria-selected", "true");
    expect(inputOf()).toHaveFocus();
    expect(inputOf()).toHaveAttribute("aria-activedescendant", option.id);
    await user.keyboard("p");
    expect(inputOf()).toHaveValue("/home/user/p");
  });

  it("enter_on_highlight_descends_keeping_tilde", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<FolderChooserDialog open onClose={() => {}} onSelect={() => {}} api={api} initialPath="~/code/" />);
    await screen.findByText("other");
    await user.click(inputOf());
    // Sorted: Fast-notes, fastestdevalive, other.
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await screen.findByText("vibe-station");
    expect(inputOf()).toHaveValue("~/code/fastestdevalive/");
  });

  it("double_click_keeps_tilde", async () => {
    const api = createMockApi();
    render(<FolderChooserDialog open onClose={() => {}} onSelect={() => {}} api={api} initialPath="~/code/" />);
    await userEvent.dblClick(await screen.findByText("fastestdevalive"));
    await screen.findByText("vibe-station");
    expect(inputOf()).toHaveValue("~/code/fastestdevalive/");
  });

  it("up_from_tilde_path", async () => {
    const api = createMockApi();
    render(
      <FolderChooserDialog open onClose={() => {}} onSelect={() => {}} api={api} initialPath="~/code/fastestdevalive/" />,
    );
    await screen.findByText("vibe-station");
    await userEvent.click(screen.getByRole("button", { name: /Up/i }));
    expect(inputOf()).toHaveValue("~/code/");
    await screen.findByText("other");
  });

  it("up_button_disabled_at_tilde_root", async () => {
    const api = createMockApi();
    render(<FolderChooserDialog open onClose={() => {}} onSelect={() => {}} api={api} initialPath="~/" />);
    await screen.findByText("code");
    expect(screen.getByRole("button", { name: /Up/i })).toBeDisabled();
  });

  it("enter_without_highlight_selects_typed_path", async () => {
    const api = createMockApi();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<FolderChooserDialog open onClose={onClose} onSelect={onSelect} api={api} initialPath="/home/user/projects" />);
    await screen.findByText("proj-a");
    await userEvent.click(inputOf());
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("/home/user/projects");
    expect(onClose).toHaveBeenCalled();
  });

  it("dot_folders_hidden_until_dot_typed", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<FolderChooserDialog open onClose={() => {}} onSelect={() => {}} api={api} initialPath="~/code/" />);
    await screen.findByText("other");
    expect(screen.queryByText(".cache")).toBeNull();
    await user.click(inputOf());
    await user.keyboard("{End}.");
    await screen.findByText(".cache");
  });

  it("no_matching_folders_only_after_settled_empty", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<FolderChooserDialog open onClose={() => {}} onSelect={() => {}} api={api} initialPath="/home/user" />);
    await screen.findByText("code");
    await user.clear(inputOf());
    await user.type(inputOf(), "/home/user/zzz");
    // Still in flight (debounce + request): no "No matching folders" yet.
    expect(screen.queryByText("No matching folders")).toBeNull();
    await screen.findByText("No matching folders");
  });

  it("list_does_not_flash_loading_between_keystrokes", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<FolderChooserDialog open onClose={() => {}} onSelect={() => {}} api={api} initialPath="/home/user" />);
    await screen.findByText("code");
    await user.clear(inputOf());
    await user.type(inputOf(), "/home/user/pro");
    expect(screen.getByText("projects")).toBeInTheDocument();
    expect(screen.queryByText("Loading directories...")).toBeNull();
  });

  it("more_row_when_truncated", async () => {
    const api = createMockApi();
    vi.spyOn(api, "fsComplete").mockResolvedValue({
      base: "/home/user",
      entries: [{ name: "projects", path: "/home/user/projects" }],
      truncated: true,
    });
    render(<FolderChooserDialog open onClose={() => {}} onSelect={() => {}} api={api} initialPath="/home/user" />);
    await screen.findByText("projects");
    expect(screen.getByText(/more… keep typing to narrow the list/)).toBeInTheDocument();
  });

  it("clicking_an_option_highlights_it_and_refocuses_the_input", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<FolderChooserDialog open onClose={() => {}} onSelect={() => {}} api={api} initialPath="/home/user" />);
    const projects = await screen.findByText("projects");
    await user.click(projects);
    expect(screen.getByRole("option", { name: /projects/ })).toHaveAttribute("aria-selected", "true");
    expect(inputOf()).toHaveFocus();
  });
});
