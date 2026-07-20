import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { DirectAgentDialog } from "./DirectAgentDialog";

/** Attachments at creation for the direct (no-worktree) JSON path. */
describe("DirectAgentDialog JSON attachments at creation", () => {
  it("creates idle → uploads staged file → sends first chat with the attachment id", async () => {
    const api = createMockApi();
    const createSpy = vi.spyOn(api, "createDirectSession");
    const uploadSpy = vi.spyOn(api, "uploadAttachments");
    const chatSpy = vi.spyOn(api, "sendChat");

    render(
      <DirectAgentDialog
        open
        api={api}
        projectId="proj-a"
        projectName="Proj A"
        onClose={() => {}}
      />,
    );
    await screen.findByText("Bugfix"); // modes loaded

    await userEvent.click(screen.getByRole("radio", { name: /Rich Chat/i }));
    await userEvent.type(screen.getByLabelText(/Initial Prompt/i), "add a test");
    const file = new File(["x"], "diagram.png", { type: "image/png" });
    await userEvent.upload(screen.getByLabelText("Attach files"), file);
    expect(await screen.findByText("diagram.png")).toBeInTheDocument();

    await userEvent.click(screen.getByText("Start Agent"));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    const body = createSpy.mock.calls[0]![0];
    expect(body).toMatchObject({ target: "direct", projectId: "proj-a", type: "agent", channel: "json" });
    expect("prompt" in body).toBe(false);

    const sessionId = (await createSpy.mock.results[0]!.value).id;
    await waitFor(() => expect(uploadSpy).toHaveBeenCalledWith(sessionId, [file]));
    const { attachments } = await uploadSpy.mock.results[0]!.value;
    await waitFor(() =>
      expect(chatSpy).toHaveBeenCalledWith(sessionId, "add a test", [attachments[0]!.id]),
    );
  });
});
