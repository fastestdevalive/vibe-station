import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { beatsFixtureEvents } from "./beatsFixture.testdata";
import { groupEvents } from "../MessageList";
import { buildTurnOutline } from "./buildTurnOutline";
import { TurnChain } from "./TurnChain";
import { fakeNav } from "./outlineTestUtils";

describe("beatsFixture", () => {
  it("produces 6 turns where turn 4 has 40+ tool calls capped to <= 12 beats, and turn 6 has no beats", () => {
    const events = beatsFixtureEvents();
    expect(events.length).toBeGreaterThan(50);

    const items = groupEvents(events);
    const nodes = buildTurnOutline(items, {});

    // Exactly 6 turns
    expect(nodes).toHaveLength(6);

    // Turn 4 has a long autonomous run
    const turn4 = nodes[3]!;
    expect(turn4.label).toContain("Implement migration");

    // Must be capped to <= 12 beats
    expect(turn4.beats.length).toBeLessThanOrEqual(12);
    expect(turn4.beats.length).toBeGreaterThan(0);

    // Raw beats were merged: counts sum to > 12 (sum of all merged counts)
    const totalCount = turn4.beats.reduce((sum, b) => sum + b.count, 0);
    expect(totalCount).toBeGreaterThan(12);

    // Turn 4 includes expected beat kinds
    const kinds = new Set(turn4.beats.map((b) => b.kind));
    expect(kinds.has("ask")).toBe(true);
    expect(kinds.has("error")).toBe(true);
    expect(kinds.has("todo")).toBe(true);
    expect(kinds.has("subagent")).toBe(true);
    expect(kinds.has("commit")).toBe(true);

    // Turn 6 is a reply with no tool (beats: [])
    const turn6 = nodes[5]!;
    expect(turn6.label).toContain("Thank you");
    expect(turn6.beats).toHaveLength(0);
  });

  it("renders in TurnChain: turn 4 always lists at most 12 beat rows (+N suffixes); turn 6 lists none; no row folds", () => {
    const events = beatsFixtureEvents();
    const items = groupEvents(events);
    const nodes = buildTurnOutline(items, {});
    const onJump = vi.fn();

    render(
      <TurnChain nodes={nodes} items={items} nav={fakeNav([0, 5])} onJump={onJump} />,
    );

    const btn = screen.getByRole("button", { name: /^Conversation outline, 6 turns\./ });
    fireEvent.click(btn);

    // Turn 4 button exists
    const dialog = screen.getByRole("dialog");
    const t4Btn = dialog.querySelector('button[id$="-row-t-4"]') as HTMLButtonElement | null;
    expect(t4Btn).not.toBeNull();
    expect(t4Btn!.getAttribute("aria-expanded")).toBeNull();
    expect(dialog.querySelector(".olp__chev")).toBeNull();
    const t4Item = t4Btn!.parentElement!;

    // Check beat rows inside Turn 4
    const beatRows = t4Item.querySelectorAll(".olp__beat");
    expect(beatRows.length).toBeLessThanOrEqual(12);
    expect(beatRows.length).toBeGreaterThan(0);

    // Turn 6 has no beats
    const t6Btn = dialog.querySelector('button[id$="-row-t-6"]') as HTMLButtonElement | null;
    expect(t6Btn).not.toBeNull();
    expect(t6Btn!.parentElement!.querySelectorAll(".olp__beat")).toHaveLength(0);
  });
});
