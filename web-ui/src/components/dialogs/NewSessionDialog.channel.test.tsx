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
  it("new-worktree JSON path → createWorktree channel:'json' (no useTmux)", async () => {
    const api = createMockApi();
    const wtSpy = vi.spyOn(api, "createWorktree");
    renderDialog(api);

    await screen.findByText("Bugfix"); // modes loaded
    // Default is "New worktree" — provide a branch.
    await userEvent.type(screen.getByLabelText("New worktree branch"), "feat/x");
    await userEvent.click(screen.getByRole("radio", { name: /Rich Chat/i }));
    await userEvent.click(screen.getByText("Create"));

    await waitFor(() => expect(wtSpy).toHaveBeenCalled());
    const body = wtSpy.mock.calls[0]![0];
    expect(body).toMatchObject({ projectId: "proj-a", channel: "json" });
    expect("useTmux" in body).toBe(false);
    expect("prompt" in body).toBe(false);
  });

  it("existing-worktree JSON path → createSession channel:'json'", async () => {
    const api = createMockApi();
    const sessSpy = vi.spyOn(api, "createSession");
    renderDialog(api);

    await screen.findByText("Bugfix");
    await userEvent.click(screen.getByRole("radio", { name: /Existing worktree/i }));
    await userEvent.click(screen.getByRole("radio", { name: /Rich Chat/i }));
    await userEvent.click(screen.getByText("Create"));

    await waitFor(() => expect(sessSpy).toHaveBeenCalled());
    const body = sessSpy.mock.calls[0]![0];
    expect(body).toMatchObject({ type: "agent", channel: "json" });
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
