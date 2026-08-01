import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { Dialog } from "./Dialog";
import { FolderChooserDialog } from "./FolderChooserDialog";

/**
 * MOCK_HOME = "/home/user", MOCK_FS_TREE:
 *   /home/user            -> projects, code, work
 *   /home/user/projects   -> proj-a, proj-b
 */
describe("FolderChooserDialog", () => {
  it("lists the initial path's children on open", async () => {
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

  it("double-click descends into a directory and lists its children", async () => {
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
    expect(screen.getByDisplayValue("/home/user/projects")).toBeInTheDocument();
  });

  it("keyboard: ArrowDown highlights, ArrowRight/Enter descends, Backspace goes up", async () => {
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
    const listbox = screen.getByRole("listbox", { name: /Folder list/i });
    listbox.focus();

    // Alphabetical order: code, projects, work.
    await user.keyboard("{ArrowDown}{ArrowDown}"); // code -> projects
    await user.keyboard("{ArrowRight}"); // descend into "projects"
    await screen.findByText("proj-a");

    await user.keyboard("{Backspace}"); // back up to /home/user
    await screen.findByText("code");
    expect(screen.getByDisplayValue("/home/user")).toBeInTheDocument();
  });

  it("Up button is a no-op at the filesystem root", async () => {
    const api = createMockApi();
    render(
      <FolderChooserDialog open onClose={() => {}} onSelect={() => {}} api={api} initialPath="/" />,
    );
    // Accessible name comes from the button's text content ("↱ Up") — the
    // "Go to parent directory" string is only the `title` tooltip.
    await waitFor(() => expect(screen.getByRole("button", { name: /Up/i })).toBeDisabled());
  });

  it("Select Folder calls onSelect with the current path and closes", async () => {
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
  it("D4: Escape closes only the inner FolderChooserDialog, leaving the host dialog open", async () => {
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
    await userEvent.click(pathInput);
    await userEvent.type(pathInput, "/projects");

    // Every character landed, and focus never left the field.
    await waitFor(() => expect(pathInput).toHaveValue("/home/user/projects"));
    expect(pathInput).toHaveFocus();
    // …and the debounced fetch still followed the typed path.
    await screen.findByText("proj-a");
  });

  it("ArrowDown from the path field hands off to the list", async () => {
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

    const pathInput = screen.getByPlaceholderText(/Type path/i);
    await userEvent.click(pathInput);
    await userEvent.keyboard("{ArrowDown}");

    const listbox = screen.getByRole("listbox");
    expect(listbox).toHaveFocus();
    // fsComplete sorts, so the first option is "code".
    expect(screen.getByRole("option", { name: /code/ })).toHaveAttribute("aria-selected", "true");
  });
});
