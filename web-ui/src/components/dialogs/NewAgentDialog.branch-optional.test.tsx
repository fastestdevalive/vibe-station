import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { NewAgentDialog } from "./NewAgentDialog";

/**
 * Branch-name-optional (web-ui side): leaving the Branch field blank must not
 * block submission when a worktree is being created and a prompt is present —
 * the daemon derives the branch name from the prompt (or a placeholder) once
 * `branch` is omitted from the request body.
 */
describe("NewAgentDialog — branch is optional", () => {
  it("submits successfully with an empty branch field when a prompt is present (existing project)", async () => {
    const api = createMockApi();
    const wtSpy = vi.spyOn(api, "createWorktree");

    render(
      <MemoryRouter>
        <NewAgentDialog open api={api} onClose={() => {}} />
      </MemoryRouter>,
    );

    const combo = await screen.findByRole("combobox", { name: /Project/i });
    await userEvent.type(combo, "Proj A");
    await userEvent.click(await screen.findByText("Proj A"));

    // Existing git project auto-enables "Use worktree" — the Branch field
    // should now be visible, and (per the new default) already blank.
    const branchInput = await screen.findByLabelText(/^Branch/i);
    expect(branchInput).toHaveValue("");

    await userEvent.type(screen.getByLabelText(/Initial prompt/i), "fix the thing");

    const submitBtn = await screen.findByRole("button", { name: "Start" });
    await waitFor(() => expect(submitBtn).not.toBeDisabled());
    await userEvent.click(submitBtn);

    await waitFor(() => expect(wtSpy).toHaveBeenCalled());
    const body = wtSpy.mock.calls[0]![0];
    expect(body.branch).toBeUndefined();

    // No blocking validation error was surfaced.
    expect(screen.queryByText(/Branch name is required/i)).not.toBeInTheDocument();
  });

  it("still validates branch FORMAT when the user types an invalid one", async () => {
    const api = createMockApi();

    render(
      <MemoryRouter>
        <NewAgentDialog open api={api} onClose={() => {}} />
      </MemoryRouter>,
    );

    const combo = await screen.findByRole("combobox", { name: /Project/i });
    await userEvent.type(combo, "Proj A");
    await userEvent.click(await screen.findByText("Proj A"));

    const branchInput = await screen.findByLabelText(/^Branch/i);
    await userEvent.type(branchInput, "..bad..branch");

    const submitBtn = await screen.findByRole("button", { name: "Start" });
    await userEvent.click(submitBtn);

    expect(await screen.findByText(/cannot contain "\.\."/i)).toBeInTheDocument();
  });
});
