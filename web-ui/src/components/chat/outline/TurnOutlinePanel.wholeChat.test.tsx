import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EMPTY_TURN_FILTER, TurnOutlinePanel } from "./TurnOutlinePanel";
import type { TurnNode } from "./buildTurnOutline";
import { makeTurn } from "./outlineTestUtils";

/** Five thousand turns that are not loaded, each with three tool calls. */
function unloadedTurns(count: number): TurnNode[] {
  return Array.from({ length: count }, (_, i) => ({
    ...makeTurn(`t${i + 1}`, i + 1, `Turn ${i + 1}`),
    unloaded: true,
    seq: (i + 1) * 10,
    tools: 3,
  }));
}

function renderPanel(nodes: TurnNode[]) {
  return render(
    <TurnOutlinePanel
      outlineId="olp-whole"
      nodes={nodes}
      filteredNodes={nodes}
      filter={EMPTY_TURN_FILTER}
      onFilterChange={vi.fn()}
      onJump={vi.fn()}
      onClose={vi.fn()}
      visibleTurnIndices={new Set()}
      mode="sticky"
      marked={null}
      newBeatKeys={new Set()}
    />,
  );
}

describe("TurnOutlinePanel: whole chat", () => {
  it("lists every unloaded turn virtualized, with its tool count and a not-loaded name", () => {
    const nodes = unloadedTurns(5000);
    renderPanel(nodes);
    expect(screen.getByTestId("olp-virtual")).toBeTruthy();
    expect(screen.getAllByRole("treeitem").length).toBeLessThan(100);
    expect(screen.getByText("5000")).toBeTruthy();

    const row = screen.getAllByRole("treeitem")[0]!;
    expect(row.className).toContain("unloaded");
    expect(row.getAttribute("aria-label")).toContain(", not loaded");
    expect(screen.getAllByText("3 tools").length).toBeGreaterThan(0);
  });

  it("a turn with one tool call reads '1 tool', never '1 tools'", () => {
    const nodes = unloadedTurns(5000).map((n, i) => ({ ...n, tools: i === 0 ? 1 : 3 }));
    renderPanel(nodes);
    expect(screen.getByText("1 tool")).toBeTruthy();
    expect(screen.queryByText("1 tools")).toBeNull();
    expect(screen.getAllByText("3 tools").length).toBeGreaterThan(0);
  });

  it("a placeholder row is a hatched '…' with no tool count until its window lands", () => {
    const nodes = unloadedTurns(3).map((n, i) => ({
      ...n,
      key: `n:${i}`,
      anchor: `n:${i}`,
      turnKey: "",
      label: "",
      seq: undefined,
      skeleton: true,
    }));
    renderPanel(nodes);
    const row = screen.getAllByRole("treeitem")[0]!;
    expect(row).toHaveClass("skeleton");
    expect(row).toHaveTextContent("…");
    expect(row.getAttribute("aria-label")).not.toContain("tools");
    expect(screen.queryByText("3 tools")).toBeNull();
  });
});
