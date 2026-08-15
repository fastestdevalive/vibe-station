import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { NewAgentDialog } from "./NewAgentDialog";

/**
 * Attachments at creation for the worktree-main JSON path: create the worktree
 * idle (prompt carried in the body only so the daemon can derive the auto
 * name/initialPrompt — `skipAutoTurn: true` stops it from also auto-enqueueing
 * turn 1), upload the staged file, then send prompt + attachment id as turn 1
 * against the returned worktree's main session.
 */
describe("NewAgentDialog JSON attachments at creation (worktree main)", () => {
  it("creates worktree idle → uploads → sends first chat to the main session", async () => {
    const api = createMockApi();
    const wtSpy = vi.spyOn(api, "createWorktree");
    const uploadSpy = vi.spyOn(api, "uploadAttachments");
    const chatSpy = vi.spyOn(api, "sendChat");

    render(
      <MemoryRouter>
        <NewAgentDialog open api={api} onClose={() => {}} />
      </MemoryRouter>,
    );

    // Pick an existing git project → worktree defaults ON.
    const combo = await screen.findByRole("combobox", { name: /Project/i });
    await userEvent.type(combo, "Proj A");
    await userEvent.click(await screen.findByText("Proj A"));

    // Branches finish loading (base-branch select appears) before submit is enabled.
    await screen.findByText("Bugfix"); // modes loaded (mode select)
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Rich Chat/i })).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole("radio", { name: /Rich Chat/i }));
    await userEvent.type(screen.getByLabelText(/Initial prompt/i), "refactor");
    const file = new File(["x"], "notes.md", { type: "text/markdown" });
    await userEvent.upload(screen.getByLabelText("Attach files"), file);
    expect(await screen.findByText("notes.md")).toBeInTheDocument();

    // Wait for branches to settle so canSubmit is true, then submit.
    const startBtn = await screen.findByRole("button", { name: /^Start$/i });
    await waitFor(() => expect(startBtn).not.toBeDisabled());
    await userEvent.click(startBtn);

    await waitFor(() => expect(wtSpy).toHaveBeenCalled());
    const body = wtSpy.mock.calls[0]![0];
    expect(body).toMatchObject({
      projectId: "proj-a",
      channel: "json",
      prompt: "refactor",
      skipAutoTurn: true,
    });

    const wt = await wtSpy.mock.results[0]!.value;
    // Session ids are independently generated (Decision 1) — no longer
    // derivable from the worktree id. Just assert one came back.
    expect(wt.mainSessionId).toBeTruthy();
    await waitFor(() => expect(uploadSpy).toHaveBeenCalledWith(wt.mainSessionId, [file]));
    const { attachments } = await uploadSpy.mock.results[0]!.value;
    await waitFor(() =>
      expect(chatSpy).toHaveBeenCalledWith(wt.mainSessionId, "refactor", [attachments[0]!.id]),
    );
  });
});
