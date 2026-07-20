import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "@/api/types";
import { createMockApi } from "@/api/mock";
import { StatusBar } from "./StatusBar";

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

  it("shows a Stop button while a turn is active", () => {
    render(<StatusBar meta={meta({ turnState: "responding" })} onStop={() => {}} />);
    expect(screen.getByText("Responding…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
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
});
