import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { ApiError } from "@/api/errors";
import { ScheduleMessagePopover, TERMINAL_SCHEDULE_NOTE } from "./ScheduleMessagePopover";

function Harness({ api, open, onClose }: { api: ReturnType<typeof createMockApi>; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} type="button">
        anchor
      </button>
      <ScheduleMessagePopover api={api} sessionId="sess-main" open={open} anchorRef={ref} targetLabel="Agent 1 · Terminal" onClose={onClose} />
    </>
  );
}

describe("ScheduleMessagePopover (compose)", () => {
  it("renders the title, target chip, verbatim warning copy and focuses the message first", async () => {
    render(<Harness api={createMockApi()} open onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog", { name: "Schedule message" });
    expect(dialog.textContent).toContain("Agent 1 · Terminal");
    expect(screen.getByText(TERMINAL_SCHEDULE_NOTE).textContent).toBe(
      "At that time the daemon waits until the agent is ready, pastes this as one message and presses Enter. Text already typed at the prompt is submitted too.",
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Message")));
    expect(screen.getByLabelText("Send at")).toBeTruthy();
  });

  it("requires a message", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "scheduleMessage");
    const user = userEvent.setup();
    render(<Harness api={api} open onClose={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Schedule" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Write a message to schedule.");
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a past time inline", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "scheduleMessage");
    const user = userEvent.setup();
    render(<Harness api={api} open onClose={() => {}} />);
    await user.type(await screen.findByLabelText("Message"), "hello");
    const input = screen.getByLabelText("Send at") as HTMLInputElement;
    act(() => {
      // jsdom's datetime-local: set via the native setter so React sees the change.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "2000-01-01T00:00");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Pick a time in the future.");
    expect(spy).not.toHaveBeenCalled();
  });

  it("Enter inserts a newline; Cmd+Enter submits exactly once and closes", async () => {
    const api = createMockApi({ simulateOutput: false });
    const spy = vi.spyOn(api, "scheduleMessage");
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Harness api={api} open onClose={onClose} />);
    const ta = (await screen.findByLabelText("Message")) as HTMLTextAreaElement;
    await user.type(ta, "line one{Enter}line two");
    expect(ta.value).toBe("line one\nline two");
    expect(spy).not.toHaveBeenCalled();
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith("sess-main", "line one\nline two", expect.any(String));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("Ctrl+Enter submits too", async () => {
    const api = createMockApi({ simulateOutput: false });
    const spy = vi.spyOn(api, "scheduleMessage");
    const user = userEvent.setup();
    render(<Harness api={api} open onClose={() => {}} />);
    await user.type(await screen.findByLabelText("Message"), "go");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  it("shows TERMINAL_DELIVERY_UNSUPPORTED inline and keeps the popover open", async () => {
    const api = createMockApi();
    vi.spyOn(api, "scheduleMessage").mockRejectedValue(
      new ApiError(JSON.stringify({ error: "This agent's mode no longer exists", code: "TERMINAL_DELIVERY_UNSUPPORTED" }), 400, "TERMINAL_DELIVERY_UNSUPPORTED"),
    );
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Harness api={api} open onClose={onClose} />);
    await user.type(await screen.findByLabelText("Message"), "go");
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    expect((await screen.findByRole("alert")).textContent).toContain("This agent's mode no longer exists");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("falls back to the code's copy when the body has no text", async () => {
    const api = createMockApi();
    vi.spyOn(api, "scheduleMessage").mockRejectedValue(new ApiError("", 400, "TERMINAL_DELIVERY_UNSUPPORTED"));
    const user = userEvent.setup();
    render(<Harness api={api} open onClose={() => {}} />);
    await user.type(await screen.findByLabelText("Message"), "go");
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Scheduling isn't supported for this agent yet");
  });

  it("Esc closes and returns focus to the anchor", async () => {
    const user = userEvent.setup();
    render(<Opener api={createMockApi()} />);
    const anchor = screen.getByRole("button", { name: "anchor" });
    await user.click(anchor);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(anchor));
  });

  it("outside click closes and returns focus to the anchor", async () => {
    const api = createMockApi();
    const user = userEvent.setup();
    render(
      <>
        <Opener api={api} />
        <div data-testid="outside">outside</div>
      </>,
    );
    const anchor = screen.getByRole("button", { name: "anchor" });
    await user.click(anchor);
    await screen.findByRole("dialog");
    await user.click(screen.getByTestId("outside"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(anchor));
  });
});

function Opener({ api }: { api: ReturnType<typeof createMockApi> }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={ref} type="button" onClick={() => setOpen(true)}>
        anchor
      </button>
      <ScheduleMessagePopover api={api} sessionId="sess-main" open={open} anchorRef={ref} targetLabel="x" onClose={() => setOpen(false)} />
    </>
  );
}
