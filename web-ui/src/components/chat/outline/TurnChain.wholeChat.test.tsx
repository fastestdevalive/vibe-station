import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TurnChain } from "./TurnChain";
import { fakeNav, makeChat } from "./outlineTestUtils";

/** Forty turns: the first 37 are not loaded, the last three are in the chat window. */
function wholeChat() {
  const { nodes: loaded, items } = makeChat(40);
  const nodes = loaded.map((n, i) => (i < 37 ? { ...n, unloaded: true, seq: (i + 1) * 10 } : n));
  return { nodes, window: items.slice(37) };
}

describe("TurnChain: whole chat", () => {
  it("spreads every turn over the chain and marks the loaded window on its own turns", () => {
    const { nodes, window } = wholeChat();
    render(
      <TurnChain
        nodes={nodes}
        items={window}
        hasMore={false}
        totalTurns={40}
        onJump={vi.fn()}
        nav={fakeNav([0, 2])}
        scrollElement={null}
      />,
    );
    const band = document.querySelector<HTMLElement>(".ol__inview");
    expect(band?.style.top).toBe("555px");
    expect(band?.style.height).toBe("45px");
    expect(document.querySelector(".ol__cap")).toBeNull();
    expect(screen.getByRole("button", { name: /40 turns/ })).toBeTruthy();
  });
});
