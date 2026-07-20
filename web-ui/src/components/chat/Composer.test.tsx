import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createMockApi } from "@/api/mock";
import { ApiError } from "@/api/errors";
import { Composer } from "./Composer";

beforeEach(() => {
  localStorage.clear();
});

describe("Composer attachments + send (5.T1)", () => {
  it("uploads a dropped file → chip appears → send includes the attachment id", async () => {
    const api = createMockApi();
    const onSend = vi.fn<(message: string, ids: string[]) => Promise<void>>(() => Promise.resolve());
    render(<Composer api={api} sessionId="s1" onSend={onSend} />);

    const file = new File(["hello"], "log.txt", { type: "text/plain" });
    const dropzone = document.querySelector(".chat-composer")!;
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });

    // Chip appears once the upload resolves.
    expect(await screen.findByText("log.txt")).toBeTruthy();

    await userEvent.setup().type(screen.getByLabelText("Message"), "check this");
    fireEvent.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const [msg, ids] = onSend.mock.calls[0]!;
    expect(msg).toBe("check this");
    expect(ids).toHaveLength(1);
  });

  it("marks an oversized upload as failed but keeps the message sendable", async () => {
    const api = createMockApi();
    vi.spyOn(api, "uploadAttachments").mockRejectedValueOnce(new ApiError("too big", 413));
    const onSend = vi.fn<(message: string, ids: string[]) => Promise<void>>(() => Promise.resolve());
    render(<Composer api={api} sessionId="s1" onSend={onSend} />);

    const file = new File(["x".repeat(10)], "big.bin", { type: "application/octet-stream" });
    fireEvent.drop(document.querySelector(".chat-composer")!, { dataTransfer: { files: [file] } });

    expect(await screen.findByText(/File too large/i)).toBeTruthy();

    // The message is still sendable (errored attachment excluded).
    await userEvent.setup().type(screen.getByLabelText("Message"), "send anyway");
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const [, ids] = onSend.mock.calls[0]!;
    expect(ids).toHaveLength(0);
  });
});

describe("Composer draft persistence (RA1)", () => {
  it("seeds the textarea from a stored draft", () => {
    localStorage.setItem("vst-chat-draft-s1", "half-written thought");
    const api = createMockApi();
    render(<Composer api={api} sessionId="s1" onSend={vi.fn()} />);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe(
      "half-written thought",
    );
  });

  it("salvaged initialText wins over a stored draft", () => {
    localStorage.setItem("vst-chat-draft-s1", "stored");
    const api = createMockApi();
    render(<Composer api={api} sessionId="s1" onSend={vi.fn()} initialText="salvaged" />);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("salvaged");
  });

  it("persists edits and clears the key on a successful send", async () => {
    const api = createMockApi();
    const onSend = vi.fn<(m: string, ids: string[]) => Promise<void>>(() => Promise.resolve());
    render(<Composer api={api} sessionId="s1" onSend={onSend} />);

    await userEvent.setup().type(screen.getByLabelText("Message"), "draft me");
    await waitFor(() => expect(localStorage.getItem("vst-chat-draft-s1")).toBe("draft me"));

    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    await waitFor(() => expect(localStorage.getItem("vst-chat-draft-s1")).toBeNull());
  });

  it("keeps drafts isolated per session", async () => {
    localStorage.setItem("vst-chat-draft-s2", "session two draft");
    const api = createMockApi();
    render(<Composer api={api} sessionId="s1" onSend={vi.fn()} />);
    // s1 has no stored draft — must not read s2's.
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");

    await userEvent.setup().type(screen.getByLabelText("Message"), "session one");
    await waitFor(() => expect(localStorage.getItem("vst-chat-draft-s1")).toBe("session one"));
    expect(localStorage.getItem("vst-chat-draft-s2")).toBe("session two draft");
  });
});
