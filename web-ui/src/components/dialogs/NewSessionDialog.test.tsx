import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { NewSessionDialog } from "./NewSessionDialog";

describe("NewSessionDialog", () => {
  it("new worktree requires branch then calls create APIs", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const cw = vi.spyOn(api, "createWorktree");
    const cs = vi.spyOn(api, "createSession");
    render(
      <NewSessionDialog
        open
        api={api}
        projectId="proj-a"
        projectName="Proj A"
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByRole("radio", { name: /New worktree/i }));
    await user.click(screen.getByRole("button", { name: /Create/i }));
    expect(screen.getByText(/requires branch/i)).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: /New worktree branch/i }), "wt-new");
    await user.click(screen.getByRole("button", { name: /Create/i }));
    await waitFor(() => {
      expect(cw).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-a",
          branch: "wt-new",
          // Base branch defaults to the project's detected default (mock proj-a → "main").
          baseBranch: "main",
        }),
      );
    });
    // New worktree: POST /worktrees spawns the main session — no separate createSession.
    expect(cs).not.toHaveBeenCalled();
  });

  it("populates the base-branch dropdown from listProjectBranches and submits the selection", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const cw = vi.spyOn(api, "createWorktree");
    render(
      <NewSessionDialog
        open
        api={api}
        projectId="proj-a"
        projectName="Proj A"
        onClose={() => {}}
      />,
    );
    // Base branch is rendered as a <select> populated with real branches.
    const select = await screen.findByRole("combobox", { name: /Base branch/i });
    await waitFor(() => {
      expect(within(select).getByRole("option", { name: "feature/example" })).toBeInTheDocument();
    });
    await user.type(screen.getByRole("textbox", { name: /New worktree branch/i }), "wt-x");
    await user.selectOptions(select, "feature/example");
    await user.click(screen.getByRole("button", { name: /Create/i }));
    await waitFor(() => {
      expect(cw).toHaveBeenCalledWith(
        expect.objectContaining({ branch: "wt-x", baseBranch: "feature/example" }),
      );
    });
  });

  it("falls back to a free-text base-branch input when branch loading fails", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    vi.spyOn(api, "listProjectBranches").mockRejectedValue(new Error("offline"));
    const cw = vi.spyOn(api, "createWorktree");
    render(
      <NewSessionDialog
        open
        api={api}
        projectId="proj-a"
        projectName="Proj A"
        onClose={() => {}}
      />,
    );
    // No dropdown — a free-text Base branch input plus an error hint.
    const input = await screen.findByRole("textbox", { name: /Base branch/i });
    expect(screen.getByText(/Couldn’t load branches/i)).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: /New worktree branch/i }), "wt-y");
    await user.type(input, "release-1");
    await user.click(screen.getByRole("button", { name: /Create/i }));
    await waitFor(() => {
      expect(cw).toHaveBeenCalledWith(
        expect.objectContaining({ branch: "wt-y", baseBranch: "release-1" }),
      );
    });
  });
});
