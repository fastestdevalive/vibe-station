import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "@/api/types";
import { createMockApi } from "@/api/mock";
import { StatusBar, turnLabel } from "./StatusBar";

function meta(extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: "s1",
    channel: "json",
    cli: "claude",
    turnState: "idle",
    queueDepth: 0,
    queuedTurnIds: [],
    editingTurnIds: [],
    ...extra,
  };
}

describe("StatusBar (5.T2)", () => {
  it("3.T1 — exported turnLabel() busy strings carry no trailing ellipsis (the WorkingIndicator's dots convey continuation)", () => {
    expect(turnLabel("thinking", 0)).toBe("Thinking");
    expect(turnLabel("responding", 0)).toBe("Responding");
    expect(turnLabel("tool", 0)).toBe("Running tool");
    expect(turnLabel("queued", 3)).toBe("Queued (3)");
    expect(turnLabel("error", 0)).toBe("Error");
    expect(turnLabel("idle", 0)).toBe("Ready");
    expect(turnLabel(undefined, 0)).toBe("Ready");
  });

  // ── P3 channel toggle (R1.1) ───────────────────────────────────────────────
  it("shows an idle-enabled channel toggle that calls setSessionChannel(tmux) on confirm", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "setSessionChannel");
    render(<StatusBar meta={meta({ turnState: "idle" })} api={api} sessionId="s1" />);
    const toggle = screen.getByRole("button", { name: /Terminal/i });
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("button", { name: /Switch to terminal/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("s1", "tmux"));
  });

  it("disables the channel toggle while a turn is active or queued (idle gate)", () => {
    render(
      <StatusBar meta={meta({ turnState: "responding" })} api={createMockApi()} sessionId="s1" />,
    );
    expect((screen.getByRole("button", { name: /Terminal/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("hides the channel toggle for a non-JSON channel", () => {
    render(<StatusBar meta={meta({ channel: "tmux" })} api={createMockApi()} sessionId="s1" />);
    expect(screen.queryByRole("button", { name: /⇄ Terminal/i })).toBeNull();
  });

  it("warns in the confirm dialog when the CLI can't import terminal history (cursor)", async () => {
    const api = createMockApi();
    render(<StatusBar meta={meta({ cli: "cursor", turnState: "idle" })} api={api} sessionId="s1" />);
    await userEvent.click(screen.getByRole("button", { name: /Terminal/i }));
    await screen.findByText(/can't read its terminal history/i);
  });

  it("does NOT warn when the CLI can import terminal history (claude)", async () => {
    const api = createMockApi();
    render(<StatusBar meta={meta({ cli: "claude", turnState: "idle" })} api={api} sessionId="s1" />);
    await userEvent.click(screen.getByRole("button", { name: /Terminal/i }));
    await screen.findByText(/reopens the same conversation in a raw terminal/i);
    expect(screen.queryByText(/can't read its terminal history/i)).toBeNull();
  });

  // ── item 2 — channel-toggle idle race (Decision 4) ─────────────────────────
  describe("channel-toggle idle race (2.T2/2.T3/2.T4)", () => {
    it("2.T2 — confirm control disables when meta.turnState flips busy while the dialog is open", async () => {
      const api = createMockApi();
      const { rerender } = render(<StatusBar meta={meta({ turnState: "idle" })} api={api} sessionId="s1" />);
      await userEvent.click(screen.getByRole("button", { name: /Terminal/i }));
      const confirmBtn = () => screen.getByRole("button", { name: /Switch to terminal/i }) as HTMLButtonElement;
      expect(confirmBtn().disabled).toBe(false);

      rerender(<StatusBar meta={meta({ turnState: "responding" })} api={api} sessionId="s1" />);
      expect(confirmBtn().disabled).toBe(true);
    });

    it("2.T3 — confirm blocked while busy: no PATCH is sent", async () => {
      const api = createMockApi();
      const spy = vi.spyOn(api, "setSessionChannel");
      const { rerender } = render(<StatusBar meta={meta({ turnState: "idle" })} api={api} sessionId="s1" />);
      await userEvent.click(screen.getByRole("button", { name: /Terminal/i }));

      rerender(<StatusBar meta={meta({ turnState: "tool" })} api={api} sessionId="s1" />);
      await userEvent.click(screen.getByRole("button", { name: /Switch to terminal/i }));
      expect(spy).not.toHaveBeenCalled();
    });

    it("2.T4 — regression: idle throughout still switches successfully", async () => {
      const api = createMockApi();
      const spy = vi.spyOn(api, "setSessionChannel");
      render(<StatusBar meta={meta({ turnState: "idle" })} api={api} sessionId="s1" />);
      await userEvent.click(screen.getByRole("button", { name: /Terminal/i }));
      await userEvent.click(screen.getByRole("button", { name: /Switch to terminal/i }));
      await waitFor(() => expect(spy).toHaveBeenCalledWith("s1", "tmux"));
    });
  });
});
