import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "@/api/types";
import { AgentFilterPicker } from "./AgentFilterPicker";
import { AgentLabel } from "./AgentLabel";

function agent(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    worktreeId: "wt1",
    projectId: "p1",
    modeId: null,
    type: "agent",
    name: id,
    isMain: false,
    state: "working",
    lifecycleState: "drafting",
    tmuxName: id,
    createdAt: "2026-10-27T09:00:00.000Z",
    ...over,
  };
}

describe("AgentFilterPicker", () => {
  it("on phones the options open in a bottom sheet; picking one closes it and returns focus", async () => {
    const onChange = vi.fn();
    render(
      <AgentFilterPicker
        value="all"
        options={[{ session: agent("a", { name: "Planner", modeIcon: "claude" }), count: 2 }]}
        total={3}
        sessionStates={{ a: "idle" }}
        mobile
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Filter by agent: All agents" });
    await userEvent.click(trigger);
    const sheet = screen.getByRole("dialog", { name: "Filter by agent" });
    const items = within(sheet).getAllByRole("menuitemradio");
    expect(items.map((i) => i.getAttribute("aria-label"))).toEqual(["All agents, 3 artifacts", "Planner, idle, 2 artifacts"]);
    expect(items[1]).toHaveClass("artifacts-menu__item--touch");
    await userEvent.click(items[1]!);
    expect(onChange).toHaveBeenCalledWith("a");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("on phones focus lands inside the sheet (no item focused first) and Tab keeps the sheet open", async () => {
    render(
      <AgentFilterPicker
        value="a"
        options={[
          { session: agent("a", { name: "Planner" }), count: 2 },
          { session: agent("b", { name: "Coder" }), count: 1 },
        ]}
        total={3}
        sessionStates={{}}
        mobile
        onChange={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Filter by agent: Planner" }));
    const sheet = screen.getByRole("dialog", { name: "Filter by agent" });
    expect(sheet).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("dialog", { name: "Filter by agent" })).toBeInTheDocument();
    expect(sheet.contains(document.activeElement)).toBe(true);
    const items = within(sheet).getAllByRole("menuitemradio");
    items[2]!.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(items[0]).toHaveFocus();
    await userEvent.tab();
    expect(items[1]).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "Filter by agent" })).toBeInTheDocument();
  });

  it("the trigger shows the selected agent's mode icon, name and count", () => {
    render(
      <AgentFilterPicker
        value="a"
        options={[{ session: agent("a", { name: "Planner", modeIcon: "codex" }), count: 2 }]}
        total={3}
        sessionStates={{}}
        mobile={false}
        onChange={() => {}}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Filter by agent: Planner" });
    expect(trigger).toHaveTextContent("Planner2");
    expect(trigger.querySelector(".mode-icon")).not.toBeNull();
  });
});

describe("AgentLabel", () => {
  it("a deleted writer renders a neutral icon and 'deleted agent'", () => {
    const { container } = render(<AgentLabel session={null} />);
    expect(container.firstElementChild).toHaveClass("artifacts-agent--deleted");
    expect(container).toHaveTextContent("deleted agent");
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector(".mode-icon")).toBeNull();
  });
});
