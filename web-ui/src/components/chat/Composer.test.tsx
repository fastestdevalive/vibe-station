import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createMockApi } from "@/api/mock";
import { ApiError } from "@/api/errors";
import { Composer } from "./Composer";

/**
 * Phase 7B rewrote the composer's message field from a `<textarea>` to a
 * Lexical contenteditable (`<SkillEditor>`). jsdom does not implement the
 * `beforeinput` machinery Lexical's own text-insertion path relies on, so
 * `userEvent.type`/`fireEvent.paste` into the contenteditable are no-ops
 * here (verified empirically — this is a jsdom limitation, not a product
 * bug; real-browser typing is exercised by Lexical's own test suite and by
 * manual/E2E verification of this feature). Tests below that used to type
 * into the box instead mount with the final content via `initialText` (the
 * same seeding path a real mount already uses for a stored draft) and
 * exercise editing through the one thing jsdom CAN drive reliably — a
 * chip's native `<input>` arg field — to verify the draft-save/send wiring.
 * The caret/selection contract itself (arrows, Backspace/Delete, popover,
 * collapse-to-`/`) has its own dedicated suite: `SkillEditor.test.tsx`.
 */

beforeEach(() => {
  localStorage.clear();
});

describe("Composer attachments + send", () => {
  it("uploads a dropped file → chip appears → send includes the attachment id", async () => {
    const api = createMockApi();
    const onSend = vi.fn<(message: string, ids: string[]) => Promise<void>>(() => Promise.resolve());
    render(<Composer api={api} sessionId="s1" onSend={onSend} initialText="check this" />);

    const file = new File(["hello"], "log.txt", { type: "text/plain" });
    const dropzone = document.querySelector(".chat-composer")!;
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });

    // Chip appears once the upload resolves.
    expect(await screen.findByText("log.txt")).toBeTruthy();

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
    render(<Composer api={api} sessionId="s1" onSend={onSend} initialText="send anyway" />);

    const file = new File(["x".repeat(10)], "big.bin", { type: "application/octet-stream" });
    fireEvent.drop(document.querySelector(".chat-composer")!, { dataTransfer: { files: [file] } });

    expect(await screen.findByText(/File too large/i)).toBeTruthy();

    // The message is still sendable (errored attachment excluded).
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const [, ids] = onSend.mock.calls[0]!;
    expect(ids).toHaveLength(0);
  });
});

describe("Composer draft persistence (RA1)", () => {
  it("seeds the editor from a stored draft", () => {
    localStorage.setItem("vst-chat-draft-s1", "half-written thought");
    const api = createMockApi();
    render(<Composer api={api} sessionId="s1" onSend={vi.fn()} />);
    expect(screen.getByLabelText("Message").textContent).toBe("half-written thought");
  });

  it("salvaged initialText wins over a stored draft", () => {
    localStorage.setItem("vst-chat-draft-s1", "stored");
    const api = createMockApi();
    render(<Composer api={api} sessionId="s1" onSend={vi.fn()} initialText="salvaged" />);
    expect(screen.getByLabelText("Message").textContent).toBe("salvaged");
  });

  it("persists edits (via a chip's arg input) and clears the key on a successful send", async () => {
    const api = createMockApi();
    const onSend = vi.fn<(m: string, ids: string[]) => Promise<void>>(() => Promise.resolve());
    render(
      <Composer
        api={api}
        sessionId="s1"
        onSend={onSend}
        initialText="{/code-review}"
        commands={[{ name: "code-review", description: "Review" }]}
      />,
    );

    const argInput = screen.getByLabelText("Arguments for code-review");
    await act(async () => {
      fireEvent.change(argInput, { target: { value: "high" } });
    });
    await waitFor(() => expect(localStorage.getItem("vst-chat-draft-s1")).toBe("{/code-review high}"));

    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("{/code-review high}", []));
    await waitFor(() => expect(localStorage.getItem("vst-chat-draft-s1")).toBeNull());
  });

  it("keeps drafts isolated per session", () => {
    localStorage.setItem("vst-chat-draft-s2", "session two draft");
    const api = createMockApi();
    render(<Composer api={api} sessionId="s1" onSend={vi.fn()} />);
    // s1 has no stored draft — must not read s2's.
    expect(screen.getByLabelText("Message").textContent).toBe("");
    expect(localStorage.getItem("vst-chat-draft-s2")).toBe("session two draft");
  });

  it("migrates a v1 (`/name args\\nprose`) draft to a chip on load", () => {
    localStorage.setItem("vst-chat-draft-s1", "/code-review high\nplease look");
    const api = createMockApi();
    render(<Composer api={api} sessionId="s1" onSend={vi.fn()} commands={[{ name: "code-review", description: "Review" }]} />);
    expect(screen.getByLabelText("Arguments for code-review")).toBeTruthy();
    expect((screen.getByLabelText("Arguments for code-review") as HTMLInputElement).value).toBe("high");
  });
});

describe("Composer Send/Stop branching (Decision 9, canSend not raw busy)", () => {
  it("busy=true, empty box → Stop button renders (the one real busy-with-nothing-to-send case)", () => {
    const api = createMockApi();
    render(<Composer api={api} sessionId="s-busy-empty" onSend={vi.fn()} busy onStop={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Stop turn" })).toBeTruthy();
    expect(screen.queryByLabelText("Send message")).toBeNull();
    expect(screen.queryByLabelText(/queues after current turn/i)).toBeNull();
  });

  it("busy=true, text ready → Send (queue variant) renders instead of Stop, and clicking it calls onSend", async () => {
    const api = createMockApi();
    const onSend = vi.fn<(m: string, ids: string[]) => Promise<void>>(() => Promise.resolve());
    render(<Composer api={api} sessionId="s-busy-text" onSend={onSend} busy onStop={vi.fn()} initialText="follow-up" />);
    expect(screen.queryByRole("button", { name: "Stop turn" })).toBeNull();
    const button = screen.getByLabelText("Send message (queues after current turn)");
    expect(button.className).toContain("chat-composer__send--queue");
    fireEvent.click(button);
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("follow-up", []));
  });

  it("a busy send that clears the box does NOT flip the button to Stop at the same position", async () => {
    const api = createMockApi();
    const onSend = vi.fn<(m: string, ids: string[]) => Promise<void>>(() => Promise.resolve());
    render(<Composer api={api} sessionId="s-busy-swap" onSend={onSend} busy onStop={vi.fn()} initialText="follow-up" />);
    fireEvent.click(screen.getByLabelText("Send message (queues after current turn)"));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    // Box is now empty and the turn is still busy — the hazard window. The
    // button must stay Send (disabled), never Stop, so an impatient second
    // click can't abort the running turn.
    await waitFor(() =>
      expect((screen.getByLabelText("Send message (queues after current turn)") as HTMLButtonElement).disabled).toBe(true),
    );
    expect(screen.queryByRole("button", { name: "Stop turn" })).toBeNull();
    // Once the settle window elapses, Stop becomes reachable again.
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop turn" })).toBeTruthy(), { timeout: 2000 });
  });

  it("busy=false, text ready → plain Send renders (no queue class)", () => {
    const api = createMockApi();
    render(<Composer api={api} sessionId="s-idle-text" onSend={vi.fn()} initialText="hello" />);
    const button = screen.getByLabelText("Send message");
    expect(button.className).not.toContain("chat-composer__send--queue");
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("busy=false, empty box → Send renders disabled (unchanged existing behavior)", () => {
    const api = createMockApi();
    render(<Composer api={api} sessionId="s-idle-empty" onSend={vi.fn()} />);
    const button = screen.getByLabelText("Send message") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.className).not.toContain("chat-composer__send--queue");
  });

  it("a parked skill chip with empty args/prose is still sendable (Decision 5 / M2 parity)", () => {
    const api = createMockApi();
    render(
      <Composer
        api={api}
        sessionId="s-parked"
        onSend={vi.fn()}
        initialText="{/code-review}"
        commands={[{ name: "code-review", description: "Review" }]}
      />,
    );
    expect((screen.getByLabelText("Send message") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Composer canSteer aria-label", () => {
  it("busy && !canSteer → aria-label is queuing label (unchanged)", () => {
    const api = createMockApi();
    render(<Composer api={api} sessionId="s-q" onSend={vi.fn()} busy initialText="text" />);
    const btn = screen.getByLabelText("Send message (queues after current turn)");
    expect(btn).toBeTruthy();
  });

  it("busy && canSteer → aria-label is steer label", () => {
    const api = createMockApi();
    render(<Composer api={api} sessionId="s-s" onSend={vi.fn()} busy canSteer initialText="text" />);
    const btn = screen.getByLabelText("Interrupts and steers the running turn");
    expect(btn).toBeTruthy();
  });

  it("busy && canSteer → no queue class (button looks like normal send, not dashed)", () => {
    const api = createMockApi();
    render(<Composer api={api} sessionId="s-steer-class" onSend={vi.fn()} busy canSteer initialText="text" />);
    const btn = screen.getByLabelText("Interrupts and steers the running turn");
    expect(btn.className).not.toContain("chat-composer__send--queue");
  });
});

describe("Composer editor autosize (Phase 7B.8 — CSS max-height, replaces JS autosizeComposerTextarea)", () => {
  it("the editor shell caps growth via CSS max-height + overflow-y auto, not inline JS height", () => {
    const api = createMockApi();
    render(<Composer api={api} sessionId="s-autosize" onSend={vi.fn()} />);
    const shell = document.querySelector(".chat-composer__textarea.chat-skill-editor") as HTMLElement;
    expect(shell.style.overflowY).toBe("auto");
    expect(shell.style.maxHeight).toContain("10");
    // No JS-driven inline `height` — that mechanism was deleted.
    expect(shell.style.height).toBe("");
  });
});
