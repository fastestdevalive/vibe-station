import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "@/api/types";
import { createMockApi } from "@/api/mock";
import { TerminalAttachmentUpload } from "./TerminalAttachmentUpload";

// The mock defines mode-1 → claude and mode-2 → cursor.
function session(extra: Partial<Session> = {}): Session {
  return {
    id: "sess-main",
    worktreeId: "wt-1",
    projectId: "proj-a",
    modeId: "mode-1",
    type: "agent",
    label: "main",
    slot: "m",
    state: "idle",
    lifecycleState: "idle",
    tmuxName: "sess-main",
    channel: "tmux",
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

describe("TerminalAttachmentUpload (item 3, Decision 5 hard-gate)", () => {
  it("3.T4 — renders the attach control for a terminal-channel claude session", async () => {
    render(<TerminalAttachmentUpload api={createMockApi()} session={session()} />);
    expect(await screen.findByLabelText(/attach files/i)).toBeTruthy();
  });

  it("3.T4 — hides for a CLI with no UserPromptSubmit hook (cursor)", async () => {
    const api = createMockApi();
    const listSpy = vi.spyOn(api, "listModes");
    render(<TerminalAttachmentUpload api={api} session={session({ modeId: "mode-2" })} />);
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    expect(screen.queryByLabelText(/attach files/i)).toBeNull();
  });

  it("hides for a plain (non-agent) terminal session", () => {
    render(
      <TerminalAttachmentUpload
        api={createMockApi()}
        session={session({ type: "terminal", modeId: null })}
      />,
    );
    expect(screen.queryByLabelText(/attach files/i)).toBeNull();
  });

  it("hides when the session is already on the JSON channel (its own composer handles attachments)", () => {
    render(<TerminalAttachmentUpload api={createMockApi()} session={session({ channel: "json" })} />);
    expect(screen.queryByLabelText(/attach files/i)).toBeNull();
  });

  it("uploading a file shows a pending chip; removing it calls the DELETE route", async () => {
    const api = createMockApi();
    const uploadSpy = vi.spyOn(api, "uploadAttachments");
    const deleteSpy = vi.spyOn(api, "deleteAttachment");
    render(<TerminalAttachmentUpload api={api} session={session()} />);

    const input = await screen.findByLabelText(/attach files/i, { selector: "input" });
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    await userEvent.upload(input, file);

    await waitFor(() => expect(uploadSpy).toHaveBeenCalledWith("sess-main", [file]));
    const chip = await screen.findByText("notes.txt");
    expect(chip).toBeTruthy();

    const removeBtn = screen.getByRole("button", { name: /remove notes.txt/i });
    await userEvent.click(removeBtn);
    await waitFor(() => expect(deleteSpy).toHaveBeenCalled());
    expect(screen.queryByText("notes.txt")).toBeNull();
  });
});
