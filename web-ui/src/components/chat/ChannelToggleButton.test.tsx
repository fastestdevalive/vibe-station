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
    await waitFor(() => expect(spy).toHaveBeenCalledWith("s1", "tmux", undefined));
  });

  it("toJson: renders '⇄ Rich Chat', dialog copy, and switches to json on confirm", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "setSessionChannel");
    render(<ChannelToggleButton api={api} sessionId="s1" direction="toJson" />);

    const trigger = screen.getByRole("button", { name: "⇄ Rich Chat" });
    await userEvent.click(trigger);
    expect(screen.getByText("Switch to Rich Chat?")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Switch to Rich Chat/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("s1", "json", undefined));
  });

  it("triggerDisabled disables the trigger button", () => {
    render(<ChannelToggleButton api={createMockApi()} sessionId="s1" direction="toTerminal" triggerDisabled />);
    expect((screen.getByRole("button", { name: "⇄ Terminal" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders split icon and text elements for responsive display", () => {
    const { container } = render(<ChannelToggleButton api={createMockApi()} sessionId="s1" direction="toTerminal" />);
    const icon = container.querySelector(".channel-toggle-button__icon");
    const text = container.querySelector(".channel-toggle-button__text");
    expect(icon).toHaveTextContent("⇄");
    expect(text).toHaveTextContent("Terminal");
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

  it("needsMode: opens mode picker first, then confirm dialog, then sends modeId", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "setSessionChannel");
    render(<ChannelToggleButton api={api} sessionId="s1" direction="toJson" needsMode={true} />);

    // Clicking trigger opens mode picker instead of confirm dialog
    await userEvent.click(screen.getByRole("button", { name: "⇄ Rich Chat" }));
    expect(await screen.findByText("Choose a mode for Rich Chat")).toBeTruthy();
    expect(screen.queryByText("Switch to Rich Chat?")).toBeNull();

    // Selecting a mode and confirming in picker opens the confirm dialog
    await userEvent.click(screen.getByRole("button", { name: "Use this mode" }));
    expect(await screen.findByText("Switch to Rich Chat?")).toBeTruthy();
    // The server starts a fresh conversation in this flow — the confirm copy must
    // not promise the "same conversation" / backfill.
    expect(screen.queryByText(/same conversation/i)).toBeNull();
    expect(screen.getByText(/new Rich Chat conversation/i)).toBeTruthy();

    // Confirming in the dialog calls setSessionChannel with chosen modeId
    await userEvent.click(screen.getByRole("button", { name: "Switch to Rich Chat" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("s1", "json", "mode-1"));
  });

  it("needsMode: cancelling in picker does not open confirm dialog or call API", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "setSessionChannel");
    render(<ChannelToggleButton api={api} sessionId="s1" direction="toJson" needsMode={true} />);

    await userEvent.click(screen.getByRole("button", { name: "⇄ Rich Chat" }));
    await screen.findByText("Choose a mode for Rich Chat");

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Choose a mode for Rich Chat")).toBeNull();
    expect(screen.queryByText("Switch to Rich Chat?")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("needsMode: cancelling in confirm dialog does not call API", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "setSessionChannel");
    render(<ChannelToggleButton api={api} sessionId="s1" direction="toJson" needsMode={true} />);

    await userEvent.click(screen.getByRole("button", { name: "⇄ Rich Chat" }));
    await screen.findByText("Choose a mode for Rich Chat");
    await userEvent.click(screen.getByRole("button", { name: "Use this mode" }));

    expect(await screen.findByText("Switch to Rich Chat?")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Switch to Rich Chat?")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("catches mode_not_found from server and opens mode picker to retry", async () => {
    const api = createMockApi();
    const spy = vi
      .spyOn(api, "setSessionChannel")
      .mockRejectedValueOnce(
        new ApiError(JSON.stringify({ error: "Mode 'gone' not found", code: "mode_not_found" }), 400, "mode_not_found"),
      )
      .mockResolvedValueOnce({ ok: true } as never);

    render(<ChannelToggleButton api={api} sessionId="s1" direction="toJson" needsMode={false} />);

    // Direct toggle opens confirm dialog
    await userEvent.click(screen.getByRole("button", { name: "⇄ Rich Chat" }));
    expect(screen.getByText("Switch to Rich Chat?")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Switch to Rich Chat" }));

    // Rejection opens the picker with fixed copy (not the API-facing daemon text)
    expect(await screen.findByText("Choose a mode for Rich Chat")).toBeTruthy();
    expect(screen.getByText(/mode no longer exists/i)).toBeTruthy();

    // Confirm picker opens confirm dialog again with replacement mode
    await userEvent.click(screen.getByRole("button", { name: "Use this mode" }));
    expect(await screen.findByText("Switch to Rich Chat?")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Switch to Rich Chat" }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy).toHaveBeenLastCalledWith("s1", "json", "mode-1");
  });
});

