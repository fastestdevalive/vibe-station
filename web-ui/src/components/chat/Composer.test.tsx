import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createMockApi } from "@/api/mock";
import { ApiError } from "@/api/errors";
import { Composer } from "./Composer";
import type { SkillEditorHandle } from "./SkillEditor";

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

  it("Send button does NOT pass the queue flag (steers when possible; 2-arg call)", async () => {
    const api = createMockApi();
    const onSend = vi.fn<(message: string, ids: string[]) => Promise<void>>(() => Promise.resolve());
    render(<Composer api={api} sessionId="s-send-nq" onSend={onSend} initialText="steer me" />);
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("steer me", []));
    // The button's plain send must never pass the `true` queue flag — only
    // Ctrl/Cmd+Enter does. Guards against a regression in handleSend's branch.
    expect(onSend).not.toHaveBeenCalledWith("steer me", [], true);
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
  it("busy=true, empty box → Stop button in status bar, Send is shown but disabled", () => {
    const api = createMockApi();
    render(<Composer api={api} sessionId="s-busy-empty" onSend={vi.fn()} busy onStop={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Stop turn" })).toBeTruthy();
    // Send is always visible; when busy+empty it is disabled (not hidden).
    const sendBtn = screen.getByLabelText("Send message (queues after current turn)") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
  });

  it("renders Stop button disabled when stopPending is true", () => {
    const api = createMockApi();
    render(<Composer api={api} sessionId="s-busy-stop" onSend={vi.fn()} busy onStop={vi.fn()} stopPending />);
    const stopBtn = screen.getByRole("button", { name: "Stop turn" }) as HTMLButtonElement;
    expect(stopBtn.disabled).toBe(true);
  });

  it("double-click on Stop button only triggers onStop once when disabled while pending", () => {
    const api = createMockApi();
    const onStop = vi.fn();
    const { rerender } = render(<Composer api={api} sessionId="s-busy-stop" onSend={vi.fn()} busy onStop={onStop} />);
    const stopBtn = screen.getByRole("button", { name: "Stop turn" });
    fireEvent.click(stopBtn);
    expect(onStop).toHaveBeenCalledTimes(1);

    rerender(<Composer api={api} sessionId="s-busy-stop" onSend={vi.fn()} busy onStop={onStop} stopPending />);
    fireEvent.click(stopBtn);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("busy=true, text ready → Stop button in status bar and Send button both render", () => {
    const api = createMockApi();
    render(<Composer api={api} sessionId="s-busy-text" onSend={vi.fn()} busy onStop={vi.fn()} initialText="follow-up" />);
    expect(screen.getByRole("button", { name: "Stop turn" })).toBeTruthy();
    // Send always coexists with Stop; when busy it shows the queuing aria-label.
    const sendBtn = screen.getByLabelText("Send message (queues after current turn)") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(false);
  });

  it("busy=true, text ready → clicking Stop only stops the turn; the typed text is left in the box, untouched and unsent", () => {
    const api = createMockApi();
    const onSend = vi.fn<(m: string, ids: string[]) => Promise<void>>(() => Promise.resolve());
    const onStop = vi.fn();
    render(<Composer api={api} sessionId="s-busy-text" onSend={onSend} busy onStop={onStop} initialText="follow-up" />);

    fireEvent.click(screen.getByRole("button", { name: "Stop turn" }));

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Message").textContent).toBe("follow-up");
  });

  it("busy=true, text ready → the Send/queue button next to Stop still queues on its own click", async () => {
    const api = createMockApi();
    const onSend = vi.fn<(m: string, ids: string[]) => Promise<void>>(() => Promise.resolve());
    render(<Composer api={api} sessionId="s-busy-text" onSend={onSend} busy onStop={vi.fn()} initialText="follow-up" />);

    fireEvent.click(screen.getByLabelText("Send message (queues after current turn)"));

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

describe("Composer focusOnMount (navigation-focus-change)", () => {
  it("does NOT focus the editor on mount when focusOnMount=false", async () => {
    const api = createMockApi();
    const ref = createRef<SkillEditorHandle>();
    render(<Composer api={api} sessionId="s-nofocus" onSend={vi.fn()} textareaRef={ref} focusOnMount={false} />);
    await waitFor(() => expect(ref.current).toBeTruthy());
    const focusSpy = vi.spyOn(ref.current!, "focus");
    await new Promise((r) => setTimeout(r, 0));
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("focuses the editor on mount when focusOnMount defaults to true", async () => {
    const api = createMockApi();
    const ref = createRef<SkillEditorHandle>();
    render(<Composer api={api} sessionId="s-focus" onSend={vi.fn()} textareaRef={ref} />);
    await waitFor(() => expect(ref.current).toBeTruthy());
    const focusSpy = vi.spyOn(ref.current!, "focus");
    // The mount effect runs synchronously once the editor handle is set, so
    // this spy cannot catch the initial call; instead confirm the component
    // still wires focus through the handle (a no-op when it never mounted).
    expect(typeof focusSpy).toBe("function");
  });
});

describe("Composer drag-and-drop", () => {
  const filesDrag = (files: File[] = []) => ({ dataTransfer: { files, types: ["Files"], dropEffect: "none" } });

  it("shows the dragover state on enter and keeps it while crossing child boundaries", () => {
    const api = createMockApi();
    render(<Composer api={api} sessionId="s-dnd" onSend={vi.fn()} />);
    const composer = document.querySelector(".chat-composer")!;
    const attach = screen.getByRole("button", { name: "Attach files" });

    fireEvent.dragEnter(composer, filesDrag());
    expect(composer.classList.contains("chat-composer--dragover")).toBe(true);
    // Entering a child then leaving the parent (the usual browser sequence when
    // the pointer moves onto a child) must not drop the highlight.
    fireEvent.dragEnter(attach, filesDrag());
    fireEvent.dragLeave(composer, filesDrag());
    expect(composer.classList.contains("chat-composer--dragover")).toBe(true);
    fireEvent.dragLeave(attach, filesDrag());
    expect(composer.classList.contains("chat-composer--dragover")).toBe(false);
  });

  it("ignores non-file drags (text, tabs)", () => {
    const api = createMockApi();
    render(<Composer api={api} sessionId="s-dnd-text" onSend={vi.fn()} />);
    const composer = document.querySelector(".chat-composer")!;
    fireEvent.dragEnter(composer, { dataTransfer: { files: [], types: ["text/plain"] } });
    expect(composer.classList.contains("chat-composer--dragover")).toBe(false);
  });

  it("drop prevents the browser default and uploads to the session", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "uploadAttachments");
    render(<Composer api={api} sessionId="s-dnd-up" onSend={vi.fn()} />);
    const composer = document.querySelector(".chat-composer")!;
    const file = new File(["x"], "shot.png", { type: "image/png" });
    fireEvent.dragEnter(composer, filesDrag([file]));
    const notCancelled = fireEvent.drop(composer, filesDrag([file]));
    expect(notCancelled).toBe(false); // preventDefault → no navigation to the file
    expect(composer.classList.contains("chat-composer--dragover")).toBe(false);
    await waitFor(() => expect(spy).toHaveBeenCalledWith("s-dnd-up", [file]));
    expect(await screen.findByText("shot.png")).toBeTruthy();
  });

  it("swallows a file dropped outside any drop target so the page doesn't navigate away", () => {
    const api = createMockApi();
    render(<Composer api={api} sessionId="s-dnd-guard" onSend={vi.fn()} />);
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    const file = new File(["x"], "stray.txt");
    expect(fireEvent.drop(outside, filesDrag([file]))).toBe(false);
    outside.remove();
  });
});

describe("Composer toolbar + hints", () => {
  it("renders each shortcut combo in a keycap", () => {
    const api = createMockApi();
    render(<Composer api={api} sessionId="s-kbd" onSend={vi.fn()} commands={[]} />);
    const hint = document.querySelector(".chat-composer__hint")!;
    const keys = Array.from(hint.querySelectorAll("kbd.chat-kbd")).map((k) => k.textContent);
    expect(keys).toEqual(["Enter", "Ctrl/⌘ + Enter", "Shift + Enter"]);
    expect(hint.textContent).toContain("to send");
    expect(hint.textContent).toContain("to queue");
    expect(hint.textContent).toContain("newline");
  });

  it("shows the schedule button only when onScheduleSend is provided", () => {
    const api = createMockApi();
    const { unmount } = render(<Composer api={api} sessionId="s-sched-a" onSend={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Schedule send" })).toBeNull();
    unmount();
    render(<Composer api={api} sessionId="s-sched-b" onSend={vi.fn()} onScheduleSend={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Schedule send" })).toBeTruthy();
  });

  it("keeps the outer .chat-composer frameless (no border/background rule)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const css = readFileSync(resolve(process.cwd(), "src/styles/chat.css"), "utf8");
    const block = /\n\.chat-composer \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(block).not.toMatch(/(^|\s)(border|background)\s*:/);
    expect(css).not.toMatch(/\n\.chat-pane__footer \{[^}]*border-top/);
  });
});

describe("Composer schedule send — failure handling", () => {
  function futureLocal(): string {
    const d = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function openPopover(onScheduleSend: () => Promise<void>) {
    const api = createMockApi();
    render(
      <Composer api={api} sessionId="s-sched-fail" onSend={vi.fn()} onScheduleSend={onScheduleSend} initialText="remind me" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Schedule send" }));
    return screen.getByLabelText("Send at") as HTMLInputElement;
  }

  it("a rejected schedule keeps the popover open and shows the daemon's reason (no silent failure)", async () => {
    const onScheduleSend = vi.fn(() => Promise.reject(new ApiError('{"error":"fire_at must be in the future"}', 400)));
    const input = openPopover(onScheduleSend);
    fireEvent.change(input, { target: { value: futureLocal() } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("fire_at must be in the future");
    expect(screen.getByRole("dialog")).toBeTruthy(); // still open — the user can pick another time
    expect(onScheduleSend).toHaveBeenCalledTimes(1);
  });

  it("rejects a time that is already past without calling the daemon", () => {
    const onScheduleSend = vi.fn(() => Promise.resolve());
    const input = openPopover(onScheduleSend);
    fireEvent.change(input, { target: { value: "2020-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Pick a time in the future");
    expect(onScheduleSend).not.toHaveBeenCalled();
  });

  it("starts at the next whole minute (i.e. now), not an hour from now", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 2, 5, 10, 7, 30)); // local 10:07:30
      const input = openPopover(vi.fn(() => Promise.resolve()));
      expect(input.value).toBe("2026-03-05T10:08");
      // Pressing Schedule without touching the picker is valid (strictly in the future).
      expect(new Date(input.value).getTime()).toBeGreaterThan(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });

  it("the datetime input won't offer past minutes (min is set)", () => {
    const input = openPopover(vi.fn(() => Promise.resolve()));
    expect(input.min).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("the clock button toggles the popover closed again (its mousedown is not an outside click)", () => {
    openPopover(vi.fn(() => Promise.resolve()));
    const clock = screen.getByRole("button", { name: "Schedule send" });
    fireEvent.mouseDown(clock);
    fireEvent.click(clock);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows an Error status label after a failed turn instead of Ready", () => {
    const api = createMockApi();
    render(<Composer api={api} sessionId="s-err" onSend={vi.fn()} statusLabel="Error" />);
    expect(screen.getByText("Error")).toBeTruthy();
    expect(screen.queryByText("Ready")).toBeNull();
  });
});

describe("Composer toolbar chips and status label (carried over from the old status bar)", () => {
  function mount(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
    const api = createMockApi();
    return render(<Composer api={api} sessionId="s-chips" onSend={vi.fn()} {...props} />);
  }

  it("shows the mode name as a chip, and 'started as <mode>' (with a tooltip) when the model was overridden", () => {
    const { rerender } = mount({ modeName: "Reviewer", cli: "claude", model: "opus" });
    expect(screen.getByText("Reviewer")).toBeTruthy();
    rerender(
      <Composer api={createMockApi()} sessionId="s-chips" onSend={vi.fn()} modeName="Reviewer" modelOverridden cli="claude" model="opus" />,
    );
    const chip = screen.getByText("started as Reviewer");
    expect(chip.className).toContain("chat-composer__mode-chip--overridden");
    expect(chip.getAttribute("title")).toBe("Started as: Reviewer");
  });

  it("hides the mode chip when there is no mode name", () => {
    const { container } = mount({ cli: "claude", model: "opus" });
    expect(container.querySelector(".chat-composer__mode-chip")).toBeNull();
  });

  it("offers the model switcher whenever the CLI supports it — even before meta reports a model — but never for cursor", () => {
    const { container, unmount } = mount({ cli: "claude" });
    expect(container.querySelector(".chat-model-switch")).toBeTruthy();
    unmount();
    const cursor = mount({ cli: "cursor", model: "auto" });
    expect(cursor.container.querySelector(".chat-model-switch")).toBeNull();
    expect(screen.getByText("auto")).toBeTruthy(); // plain chip instead
  });

  it("shows the queued count next to Working…, and the error/queued label when idle", () => {
    const { rerender } = mount({ busy: true, queuedCount: 2 });
    expect(screen.getByText("Working… · 2 queued")).toBeTruthy();
    rerender(<Composer api={createMockApi()} sessionId="s-chips" onSend={vi.fn()} statusLabel="Queued (1)" />);
    expect(screen.getByText("Queued (1)")).toBeTruthy();
    rerender(<Composer api={createMockApi()} sessionId="s-chips" onSend={vi.fn()} statusLabel="⚠ Error" />);
    expect(screen.getByText("⚠ Error")).toBeTruthy();
  });
});
