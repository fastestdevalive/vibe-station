import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TurnChain } from "./TurnChain";
import { fakeNav, makeChat } from "./outlineTestUtils";

const wheelOn = (el: Element, deltaY: number) =>
  fireEvent(el, new WheelEvent("wheel", { deltaY, deltaMode: 0, cancelable: true, bubbles: true }));

const rowOf = (key: string) => document.getElementById(`${screen.getByRole("dialog").id}-row-${key}`)!;

describe("TurnChain: steps of an unloaded turn", () => {
  it("reports the marked turn, and null when the list closes", () => {
    const { nodes, items } = makeChat(10, 2);
    const onMarkedTurn = vi.fn();
    render(
      <TurnChain
        nodes={nodes}
        items={items}
        hasMore={false}
        onJump={vi.fn()}
        onMarkedTurn={onMarkedTurn}
        nav={fakeNav([0, 0])}
        scrollElement={null}
      />,
    );
    const chain = screen.getByRole("button", { name: /^Conversation outline/ });
    wheelOn(chain, -100);
    expect(rowOf("t1")).toHaveClass("scrub");
    expect(onMarkedTurn).toHaveBeenLastCalledWith("t1");

    fireEvent.keyDown(chain, { key: "Escape" });
    expect(onMarkedTurn).toHaveBeenLastCalledWith(null);
  });

  it("shows Loading steps… on the pending row only", () => {
    const { nodes, items } = makeChat(10, 2);
    render(
      <TurnChain
        nodes={nodes}
        items={items}
        hasMore={false}
        onJump={vi.fn()}
        pendingStepsKey="t3"
        nav={fakeNav([0, 0])}
        scrollElement={null}
      />,
    );
    const chain = screen.getByRole("button", { name: /^Conversation outline/ });
    fireEvent.keyDown(chain, { key: "Enter" });

    const chips = document.querySelectorAll(".olp__chip--loading");
    expect(chips).toHaveLength(1);
    expect(rowOf("t3")).toContainElement(chips[0] as HTMLElement);
    expect(rowOf("t3")).toHaveTextContent("Loading steps…");
    expect(rowOf("t2")).not.toHaveTextContent("Loading steps…");
    expect(rowOf("t4")).not.toHaveTextContent("Loading steps…");
  });
});
