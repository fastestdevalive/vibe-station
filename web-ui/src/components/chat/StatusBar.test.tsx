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
  it("renders used/total tokens with context %", () => {
    render(
      <StatusBar
        meta={meta({
          model: "opus",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
            totalTokens: 12000,
            contextWindow: 200000,
            model: "opus",
          },
        })}
      />,
    );
    expect(screen.getByText(/12,000 \/ 200,000 tok/)).toBeTruthy();
    expect(screen.getByText(/\(6%\)/)).toBeTruthy();
    expect(screen.getByText("opus")).toBeTruthy();
  });

  it("hides cost gracefully when costUsd is missing", () => {
    const { container } = render(
      <StatusBar
        meta={meta({
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
            totalTokens: 100,
            model: "sonnet",
          },
        })}
      />,
    );
    expect(container.querySelector(".chat-statusbar__cost")).toBeNull();
    // No contextWindow → no percentage shown.
    expect(container.querySelector(".chat-statusbar__pct")).toBeNull();
    expect(screen.getByText(/100 tok/)).toBeTruthy();
  });

  it("shows the turn-state label and queue depth", () => {
    render(<StatusBar meta={meta({ turnState: "queued", queueDepth: 2 })} queueDepth={2} />);
    expect(screen.getByText("Queued (2)")).toBeTruthy();
  });

  it("shows a Stop button — and NO duplicate turn label — while a turn is active", () => {
    const { container } = render(<StatusBar meta={meta({ turnState: "responding" })} onStop={() => {}} />);
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    // The label lives next to the in-feed WorkingIndicator's dots instead.
    expect(screen.queryByText("Responding")).toBeNull();
    expect(container.querySelector(".chat-statusbar__state")).toBeNull();
  });

  it("keeps the turn label for non-busy states (no in-feed indicator to duplicate)", () => {
    const { container, rerender } = render(<StatusBar meta={meta({ turnState: "idle" })} onStop={() => {}} />);
    expect(screen.getByText("Ready")).toBeTruthy();
    rerender(<StatusBar meta={meta({ turnState: "error" })} onStop={() => {}} />);
    expect(screen.getByText("Error")).toBeTruthy();
    // error is never busy → the ⚠ icon is unaffected by the busy suppression.
    expect(container.querySelector(".chat-statusbar__state--error")?.textContent).toContain("⚠");
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("3.T1 — no longer renders a circular spinner while busy (Decision 7 — replaced by the in-feed WorkingIndicator)", () => {
    const { container } = render(<StatusBar meta={meta({ turnState: "responding" })} onStop={() => {}} />);
    expect(container.querySelector(".chat-spinner")).toBeNull();
  });

  it("3.T1 — exported turnLabel() busy strings carry no trailing ellipsis (the WorkingIndicator's dots convey continuation)", () => {
    expect(turnLabel("thinking", 0)).toBe("Thinking");
    expect(turnLabel("responding", 0)).toBe("Responding");
    expect(turnLabel("tool", 0)).toBe("Running tool");
    expect(turnLabel("queued", 3)).toBe("Queued (3)");
    expect(turnLabel("error", 0)).toBe("Error");
    expect(turnLabel("idle", 0)).toBe("Ready");
    expect(turnLabel(undefined, 0)).toBe("Ready");
  });

  it("renders the model switcher when api + sessionId are provided", () => {
    render(<StatusBar meta={meta({ model: "sonnet" })} api={createMockApi()} sessionId="s1" />);
    expect(screen.getByRole("button", { name: /Change model/i })).toBeTruthy();
  });

  it("does NOT render a switcher for cursor (the CLI ignores --model in JSON turns)", () => {
    render(<StatusBar meta={meta({ cli: "cursor", model: "auto" })} api={createMockApi()} sessionId="s1" />);
    expect(screen.queryByRole("button", { name: /Change model/i })).toBeNull();
    // Falls back to the plain model label.
    expect(screen.getByText("auto")).toBeTruthy();
  });

  // ── P3 channel toggle (R1.1) ───────────────────────────────────────────────
  it("shows an idle-enabled channel toggle that calls setSessionChannel(tmux) on confirm", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "setSessionChannel");
    render(<StatusBar meta={meta({ turnState: "idle" })} api={api} sessionId="s1" />);
    const toggle = screen.getByRole("button", { name: /Terminal/i });
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(toggle);
    // Confirm dialog opens; the confirm action triggers the PATCH.
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
    const api = createMockApi(); // mock: cursor importsNativeHistory=false
    render(<StatusBar meta={meta({ cli: "cursor", turnState: "idle" })} api={api} sessionId="s1" />);
    await userEvent.click(screen.getByRole("button", { name: /Terminal/i }));
    await screen.findByText(/can't read its terminal history/i);
  });

  it("does NOT warn when the CLI can import terminal history (claude)", async () => {
    const api = createMockApi(); // mock: claude importsNativeHistory=true
    render(<StatusBar meta={meta({ cli: "claude", turnState: "idle" })} api={api} sessionId="s1" />);
    await userEvent.click(screen.getByRole("button", { name: /Terminal/i }));
    // Dialog is open (default switch explanation present) but no lossy warning.
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

      // Session goes busy mid-dialog — StatusBar re-renders with live meta.
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

describe("StatusBar busy dots when scrolled away", () => {
  const busyMeta = meta({ turnState: "thinking" });

  it("renders the dots (and NO busy text label) left of Stop when busy and scrolled away", () => {
    const { container } = render(<StatusBar meta={busyMeta} atBottom={false} onStop={() => {}} />);
    expect(container.querySelectorAll(".chat-working-indicator__dot")).toHaveLength(3);
    // The removed duplicate label must NOT come back with the dots.
    expect(screen.queryByText("Thinking")).toBeNull();
    // Order: dots precede the Stop button in DOM order.
    const dots = container.querySelector(".chat-statusbar__busy")!;
    expect(dots.className).not.toContain("chat-statusbar__busy--hidden");
    const stop = container.querySelector(".chat-statusbar__stop")!;
    expect(dots.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the dots mounted but HIDDEN while busy at the bottom, so the Stop button never shifts", () => {
    // Present-but-hidden (not unmounted): the reserved box keeps the row's
    // layout identical across the near-bottom threshold the user is crossing
    // while they scroll.
    const { container } = render(<StatusBar meta={busyMeta} atBottom onStop={() => {}} />);
    const dots = container.querySelector(".chat-statusbar__busy")!;
    expect(dots).toBeTruthy();
    expect(dots.className).toContain("chat-statusbar__busy--hidden");
    expect(dots.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".chat-statusbar__stop")).toBeTruthy();
  });

  it("defaults to hidden dots when `atBottom` is not supplied at all", () => {
    const { container } = render(<StatusBar meta={busyMeta} onStop={() => {}} />);
    expect(container.querySelector(".chat-statusbar__busy--hidden")).toBeTruthy();
  });

  it("renders no dots when idle, even if scrolled away", () => {
    const { container } = render(<StatusBar meta={meta({ turnState: "idle" })} atBottom={false} onStop={() => {}} />);
    expect(container.querySelector(".chat-statusbar__busy")).toBeNull();
    expect(screen.getByText("Ready")).toBeTruthy();
  });
});
