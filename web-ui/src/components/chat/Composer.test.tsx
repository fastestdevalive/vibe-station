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

describe("Composer textarea auto-grow", () => {
  // jsdom has no real layout, so `scrollHeight` is stubbed per-assertion.
  // `getComputedStyle`'s line-height/padding/border resolve to jsdom's UA
  // defaults, NOT this project's CSS (vitest doesn't apply stylesheets) —
  // read the same computed style the component reads, rather than assuming a
  // specific pixel cap, so this test isn't coupled to jsdom's UA defaults.
  function expectedCapPx(textarea: HTMLTextAreaElement): number {
    const style = window.getComputedStyle(textarea);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const extra =
      (parseFloat(style.paddingTop) || 0) +
      (parseFloat(style.paddingBottom) || 0) +
      (parseFloat(style.borderTopWidth) || 0) +
      (parseFloat(style.borderBottomWidth) || 0);
    return lineHeight * 10 + extra;
  }

  it("grows to fit content up to the ~10-line cap, then caps and scrolls", () => {
    const api = createMockApi();
    render(<Composer api={api} sessionId="s-grow" onSend={vi.fn()} />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    const cap = expectedCapPx(textarea);

    Object.defineProperty(textarea, "scrollHeight", { value: 90, configurable: true });
    fireEvent.change(textarea, { target: { value: "line1\nline2\nline3" } });
    expect(textarea.style.height).toBe("90px");
    expect(textarea.style.overflowY).toBe("hidden");

    Object.defineProperty(textarea, "scrollHeight", { value: cap + 300, configurable: true });
    fireEvent.change(textarea, { target: { value: "a\n".repeat(20) } });
    expect(textarea.style.height).toBe(`${cap}px`);
    expect(textarea.style.overflowY).toBe("auto");
  });

  it("shrinks back down as content is deleted", () => {
    const api = createMockApi();
    render(<Composer api={api} sessionId="s-shrink" onSend={vi.fn()} />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    const cap = expectedCapPx(textarea);

    Object.defineProperty(textarea, "scrollHeight", { value: cap + 100, configurable: true });
    fireEvent.change(textarea, { target: { value: "a\n".repeat(15) } });
    expect(textarea.style.height).toBe(`${cap}px`);

    Object.defineProperty(textarea, "scrollHeight", { value: 40, configurable: true });
    fireEvent.change(textarea, { target: { value: "short" } });
    expect(textarea.style.height).toBe("40px");
    expect(textarea.style.overflowY).toBe("hidden");
  });
});
