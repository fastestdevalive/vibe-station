import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { ApiError } from "@/api/errors";
import { ChannelToggleButton } from "./ChannelToggleButton";

describe("ChannelToggleButton (item 4, Decision 6) — 4.T1", () => {
  it("toTerminal: renders '⇄ Terminal', dialog copy, and switches to tmux on confirm", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "setSessionChannel");
    render(<ChannelToggleButton api={api} sessionId="s1" direction="toTerminal" />);

    const trigger = screen.getByRole("button", { name: "⇄ Terminal" });
    await userEvent.click(trigger);
    expect(screen.getByText("Switch to terminal?")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Switch to terminal/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("s1", "tmux"));
  });

  it("toJson: renders '⇄ Rich Chat', dialog copy, and switches to json on confirm", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "setSessionChannel");
    render(<ChannelToggleButton api={api} sessionId="s1" direction="toJson" />);

    const trigger = screen.getByRole("button", { name: "⇄ Rich Chat" });
    await userEvent.click(trigger);
    expect(screen.getByText("Switch to Rich Chat?")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Switch to Rich Chat/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("s1", "json"));
  });

  it("triggerDisabled disables the trigger button", () => {
    render(<ChannelToggleButton api={createMockApi()} sessionId="s1" direction="toTerminal" triggerDisabled />);
    expect((screen.getByRole("button", { name: "⇄ Terminal" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("confirmBlocked shows the blocked message and disables the confirm control", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "setSessionChannel");
    render(
      <ChannelToggleButton
        api={api}
        sessionId="s1"
        direction="toTerminal"
        confirmBlocked
        blockedMessage="busy right now"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "⇄ Terminal" }));
    expect(screen.getByText("busy right now")).toBeTruthy();
    const confirmBtn = screen.getByRole("button", { name: /Switch to terminal/i }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    await userEvent.click(confirmBtn);
    expect(spy).not.toHaveBeenCalled();
  });

  it("shows the daemon's real reason instead of the generic busy copy for a non-idle 400 (e.g. unsupported CLI)", async () => {
    const api = createMockApi();
    vi.spyOn(api, "setSessionChannel").mockRejectedValue(
      new ApiError(JSON.stringify({ error: "agy does not support channel toggle" }), 400),
    );
    render(<ChannelToggleButton api={api} sessionId="s1" direction="toJson" />);
    await userEvent.click(screen.getByRole("button", { name: "⇄ Rich Chat" }));
    await userEvent.click(screen.getByRole("button", { name: /Switch to Rich Chat/i }));
    await waitFor(() => expect(screen.getByText("agy does not support channel toggle")).toBeTruthy());
    // The generic per-direction copy must NOT be what's shown for this case.
    expect(screen.queryByText("Couldn't switch — try again in a moment.")).toBeNull();
  });

  it("falls back to the generic busy copy for a real 409 (not_idle) or a non-ApiError failure", async () => {
    const api = createMockApi();
    vi.spyOn(api, "setSessionChannel").mockRejectedValue(
      new ApiError(JSON.stringify({ error: "not_idle" }), 409),
    );
    render(<ChannelToggleButton api={api} sessionId="s1" direction="toTerminal" />);
    await userEvent.click(screen.getByRole("button", { name: "⇄ Terminal" }));
    await userEvent.click(screen.getByRole("button", { name: /Switch to terminal/i }));
    await waitFor(() =>
      expect(screen.getByText("Couldn't switch — the session is busy. Try again when idle.")).toBeTruthy(),
    );
  });
});
