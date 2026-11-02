import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardCardGroup } from "./DashboardCardGroup";

interface Item {
  id: string;
  at: string;
  label: string;
}

const T0 = "2026-01-01T00:00:00.000Z";

function renderGroup(items: Item[]) {
  const ui = (list: Item[], expanded = false) => (
    <DashboardCardGroup
      items={list}
      idOf={(i) => i.id}
      activityOf={(i) => i.at}
      renderItem={(i) => <div data-testid={`card-${i.id}`}>{i.label}</div>}
      expanded={expanded}
      onExpand={() => {}}
      className="g"
      header={<div>h</div>}
    />
  );
  const view = render(ui(items));
  return {
    ...view,
    rerenderWith: (list: Item[], expanded = false) => view.rerender(ui(list, expanded)),
  };
}

describe("DashboardCardGroup layout measuring", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not re-measure cards when only card content changes (same order)", () => {
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect");
    const a = { id: "a", at: T0, label: "one" };
    const b = { id: "b", at: T0, label: "two" };
    const { rerenderWith } = renderGroup([a, b]);
    const afterMount = spy.mock.calls.length;

    // Simulates a `session:activity` frame: new item objects, same ids/order.
    rerenderWith([
      { ...a, label: "one!" },
      { ...b, label: "two!" },
    ]);
    rerenderWith([
      { ...a, label: "one!!" },
      { ...b, label: "two!!" },
    ]);

    expect(spy.mock.calls.length).toBe(afterMount);
  });

  it("still measures when the visible card set changes", () => {
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect");
    const a = { id: "a", at: T0, label: "one" };
    const b = { id: "b", at: T0, label: "two" };
    const { rerenderWith } = renderGroup([a, b]);
    const afterMount = spy.mock.calls.length;

    rerenderWith([a]); // card b removed -> layout dependency changes

    expect(spy.mock.calls.length).toBeGreaterThan(afterMount);
  });
});
