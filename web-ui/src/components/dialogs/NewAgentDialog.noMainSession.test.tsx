import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { NewAgentDialog } from "./NewAgentDialog";

/**
 * 3.T8 — a worktree with `mainSessionId: null` must never fall back to
 * guessing `${wt.id}-m` (that id shape stopped being valid the moment session
 * ids became independently generated, Decision 1). The dialog should just
 * skip sending the first turn rather than crash or address a nonexistent
 * session.
 */
describe("NewAgentDialog — worktree with no mainSessionId", () => {
  it("never guesses an id; skips the first-turn send instead", async () => {
    const api = createMockApi();
    vi.spyOn(api, "createWorktree").mockImplementation(async (body) => ({
      id: "wt-no-main",
      projectId: body.projectId,
      branch: body.branch ?? "wt-no-main",
      baseBranch: body.baseBranch ?? "main",
      baseSha: "0".repeat(40),
      createdAt: new Date().toISOString(),
      pinnedAt: null,
      hiddenAt: null,
      mainSessionId: null,
    }));
    const chatSpy = vi.spyOn(api, "sendChat");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <MemoryRouter>
        <NewAgentDialog open api={api} onClose={() => {}} />
      </MemoryRouter>,
    );

    const combo = await screen.findByRole("combobox", { name: /Project/i });
    await userEvent.type(combo, "Proj A");
    await userEvent.click(await screen.findByText("Proj A"));

    await screen.findByText("Bugfix");
    await waitFor(() => expect(screen.getByRole("radio", { name: /Rich Chat/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("radio", { name: /Rich Chat/i }));
    await userEvent.type(screen.getByLabelText(/Initial prompt/i), "refactor");

    const startBtn = await screen.findByRole("button", { name: /^Start$/i });
    await waitFor(() => expect(startBtn).not.toBeDisabled());
    await userEvent.click(startBtn);

    // Never called with a guessed `${wt.id}-m` (or anything else) — the
    // create flow must not send a first turn without a real session id.
    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
    expect(chatSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
