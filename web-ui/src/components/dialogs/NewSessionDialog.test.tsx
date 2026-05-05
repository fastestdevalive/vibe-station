import { render, screen, waitFor } from "@testing-library/react";
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
          baseBranch: "main",
        }),
      );
    });
    // New worktree: POST /worktrees spawns the main session — no separate createSession.
    expect(cs).not.toHaveBeenCalled();
  });
});
