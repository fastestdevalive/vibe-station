import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { NewSessionDialog } from "./NewSessionDialog";

function renderDialog(api: ReturnType<typeof createMockApi>) {
  return render(
    <NewSessionDialog open api={api} projectId="proj-a" projectName="Proj A" onClose={() => {}} />,
  );
}

describe("NewSessionDialog channel + attachments", () => {
  it("new-worktree JSON path → createWorktree channel:'json' (no useTmux, prompt carried for naming, auto-turn skipped)", async () => {
    const api = createMockApi();
    const wtSpy = vi.spyOn(api, "createWorktree");
    renderDialog(api);

    await screen.findByText("Bugfix"); // modes loaded
    // Default is "New worktree" — provide a branch.
    await userEvent.type(screen.getByLabelText("New worktree branch"), "feat/x");
    await userEvent.click(screen.getByRole("radio", { name: /Rich Chat/i }));
    await userEvent.type(screen.getByLabelText(/Initial prompt/i), "fix the login flow");
    await userEvent.click(screen.getByText("Create"));

    await waitFor(() => expect(wtSpy).toHaveBeenCalled());
    const body = wtSpy.mock.calls[0]![0];
    // `prompt` still travels in the create body (so the daemon can derive the
    // auto name / initialPrompt from it) but `skipAutoTurn` stops the daemon
    // from also enqueueing it as turn 1 — the actual turn 1 send happens
    // separately via `sendJsonFirstTurn` once attachments are uploaded.
    expect(body).toMatchObject({
      projectId: "proj-a",
      channel: "json",
      prompt: "fix the login flow",
      skipAutoTurn: true,
    });
    expect("useTmux" in body).toBe(false);
  });

  it("existing-worktree JSON path → createSession channel:'json' (prompt carried, auto-turn skipped)", async () => {
    const api = createMockApi();
    const sessSpy = vi.spyOn(api, "createSession");
    renderDialog(api);

    await screen.findByText("Bugfix");
    await userEvent.click(screen.getByRole("radio", { name: /Existing worktree/i }));
    await userEvent.click(screen.getByRole("radio", { name: /Rich Chat/i }));
    await userEvent.type(screen.getByLabelText(/Initial prompt/i), "wire the settings toggle");
    await userEvent.click(screen.getByText("Create"));

    await waitFor(() => expect(sessSpy).toHaveBeenCalled());
    const body = sessSpy.mock.calls[0]![0];
    expect(body).toMatchObject({
      type: "agent",
      channel: "json",
      prompt: "wire the settings toggle",
      skipAutoTurn: true,
    });
    expect("useTmux" in body).toBe(false);
  });

  it("terminal default is unchanged — useTmux sent, no channel", async () => {
    const api = createMockApi();
    const wtSpy = vi.spyOn(api, "createWorktree");
    renderDialog(api);

    await screen.findByText("Bugfix");
    await userEvent.type(screen.getByLabelText("New worktree branch"), "feat/y");
    await userEvent.click(screen.getByText("Create"));

    await waitFor(() => expect(wtSpy).toHaveBeenCalled());
    const body = wtSpy.mock.calls[0]![0];
    expect(body.channel).toBeUndefined();
    expect(body.useTmux).toBe(true);
  });

  it("shows the attachment picker for all channels", async () => {
    const api = createMockApi();
    renderDialog(api);
    await screen.findByText("Bugfix");

    expect(screen.getByLabelText("Attach files")).toBeInTheDocument();
  });
});
