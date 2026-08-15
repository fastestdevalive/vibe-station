import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { NewTabDialog } from "./NewTabDialog";

/**
 * Attachments at creation for the additional-tab JSON path: the dialog must
 * create the session idle (prompt carried in the body only so the daemon can
 * derive the auto name/initialPrompt from it — `skipAutoTurn: true` stops it
 * from also auto-enqueueing turn 1), upload the staged file, then send the
 * prompt + attachment id as turn 1 itself.
 */
describe("NewTabDialog JSON attachments at creation", () => {
  it("creates idle → uploads staged file → sends first chat with the attachment id", async () => {
    const api = createMockApi();
    const createSpy = vi.spyOn(api, "createSession");
    const uploadSpy = vi.spyOn(api, "uploadAttachments");
    const chatSpy = vi.spyOn(api, "sendChat");

    render(<NewTabDialog open api={api} worktreeId="wt-1" onClose={() => {}} />);
    await screen.findByText("Bugfix"); // modes loaded

    // Choose JSON, type a prompt, stage a file.
    await userEvent.click(screen.getByRole("radio", { name: /Rich Chat/i }));
    await userEvent.type(screen.getByLabelText("Prompt"), "fix the bug");
    const file = new File(["hello"], "log.txt", { type: "text/plain" });
    await userEvent.upload(screen.getByLabelText("Attach files"), file);
    expect(await screen.findByText("log.txt")).toBeInTheDocument();

    await userEvent.click(screen.getByText("Create"));

    // 1) Session created idle: channel json, prompt carried for naming, auto-turn skipped (no double turn-1).
    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    const body = createSpy.mock.calls[0]![0];
    expect(body).toMatchObject({
      worktreeId: "wt-1",
      type: "agent",
      channel: "json",
      prompt: "fix the bug",
      skipAutoTurn: true,
    });

    // 2) Uploaded against the new session id.
    const sessionId = (await createSpy.mock.results[0]!.value).id;
    await waitFor(() => expect(uploadSpy).toHaveBeenCalledWith(sessionId, [file]));

    // 3) First chat carries the prompt + the uploaded attachment id.
    const { attachments } = await uploadSpy.mock.results[0]!.value;
    await waitFor(() =>
      expect(chatSpy).toHaveBeenCalledWith(sessionId, "fix the bug", [attachments[0]!.id]),
    );
  });

  it("terminal path is unchanged — no upload/chat, prompt in the create body", async () => {
    const api = createMockApi();
    const createSpy = vi.spyOn(api, "createSession");
    const uploadSpy = vi.spyOn(api, "uploadAttachments");
    const chatSpy = vi.spyOn(api, "sendChat");

    render(<NewTabDialog open api={api} worktreeId="wt-1" onClose={() => {}} />);
    await screen.findByText("Bugfix");

    await userEvent.type(screen.getByLabelText("Prompt"), "do it");
    await userEvent.click(screen.getByText("Create"));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    expect(createSpy.mock.calls[0]![0]).toMatchObject({ prompt: "do it", useTmux: true });
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(chatSpy).not.toHaveBeenCalled();
  });
});
