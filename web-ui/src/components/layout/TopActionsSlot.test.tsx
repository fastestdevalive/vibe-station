import { describe, it, expect } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { createTopActionsStore, TopActionsProvider } from "@/context/TopActionsContext";
import { ActionsHost, ToolActionsHost, TopActionsOwner } from "./TopActionsSlot";
import { ToolsInsetProvider, type ToolsInsetContextValue } from "@/context/ToolsInsetContext";

function Probe() {
  return <button>probe</button>;
}

function wrap(children: ReactNode) {
  const store = createTopActionsStore();
  return render(<TopActionsProvider store={store}>{children}</TopActionsProvider>);
}

const activeReserves = (root: ParentNode) => Array.from(root.querySelectorAll(".actions-host__reserve[data-active]"));

describe("TopActionsOwner / ActionsHost (reserve)", () => {
  it("renders the chip content once, outside every host, and exactly one reserve is active", () => {
    const { container } = wrap(
      <>
        <div data-testid="agent">
          <ActionsHost zone="agent" />
        </div>
        <TopActionsOwner zones={["tools", "agent"]}>
          <Probe />
        </TopActionsOwner>
      </>,
    );
    expect(screen.getAllByText("probe")).toHaveLength(1);
    expect(screen.getByTestId("agent").contains(screen.getByText("probe"))).toBe(false);
    expect(screen.getByText("probe").closest(".top-actions-anchor")).not.toBeNull();
    expect(container.querySelectorAll(".actions-host")).toHaveLength(1);
    expect(activeReserves(screen.getByTestId("agent"))).toHaveLength(1);
  });

  it("the reserve moves to the tools host when one registers, still exactly one active, and the chip node never moves", () => {
    let show: (v: boolean) => void = () => {};
    function Harness() {
      const [on, setOn] = useState(false);
      show = setOn;
      return (
        <>
          <div data-testid="agent">
            <ActionsHost zone="agent" />
          </div>
          <div data-testid="tools">{on ? <ActionsHost zone="tools" /> : null}</div>
          <TopActionsOwner zones={["tools", "agent"]}>
            <Probe />
          </TopActionsOwner>
        </>
      );
    }
    const { container } = wrap(<Harness />);
    const probe = screen.getByText("probe");
    expect(activeReserves(screen.getByTestId("agent"))).toHaveLength(1);
    act(() => show(true));
    expect(activeReserves(container)).toHaveLength(1);
    expect(activeReserves(screen.getByTestId("tools"))).toHaveLength(1);
    expect(activeReserves(screen.getByTestId("agent"))).toHaveLength(0);
    act(() => show(false));
    expect(activeReserves(screen.getByTestId("agent"))).toHaveLength(1);
    expect(screen.getByText("probe")).toBe(probe);
  });

  it("a disabled host renders no DOM and reserves nothing", () => {
    const { container } = wrap(
      <>
        <ActionsHost zone="agent" enabled={false} />
        <TopActionsOwner zones={["agent"]}>
          <Probe />
        </TopActionsOwner>
      </>,
    );
    expect(container.querySelector(".actions-host")).toBeNull();
    expect(activeReserves(container)).toHaveLength(0);
  });

  it("empty zones: no active reserve (the chip itself is still rendered by the owner)", () => {
    const { container } = wrap(
      <>
        <ActionsHost zone="agent" />
        <TopActionsOwner zones={[]}>
          <Probe />
        </TopActionsOwner>
      </>,
    );
    expect(container.querySelector(".actions-host__reserve")).not.toBeNull();
    expect(activeReserves(container)).toHaveLength(0);
  });

  it("host spans are [pane][reserve], the reserve carries the drag region", () => {
    const { container } = wrap(<ActionsHost zone="agent" />);
    const host = container.querySelector(".actions-host") as HTMLElement;
    expect(host.children).toHaveLength(2);
    expect(host.children[1]).toHaveClass("actions-host__reserve");
    expect(host.children[1]).toHaveAttribute("data-tauri-drag-region", "deep");
  });

  it("without a provider the host renders null and the owner does not throw", () => {
    const { container } = render(
      <>
        <ActionsHost zone="agent" />
        <TopActionsOwner zones={["agent"]}>
          <Probe />
        </TopActionsOwner>
      </>,
    );
    expect(container.querySelector(".actions-host")).toBeNull();
    expect(screen.getAllByText("probe")).toHaveLength(1);
  });
});

describe("ToolActionsHost flags", () => {
  it("pane={false} never gets pane controls; reserve={false} never reserves", () => {
    const inset = (hostScope: string): ToolsInsetContextValue => ({
      isPanelOpen: true,
      listHostsPane: false,
      hostScope,
      hostsGlobal: true,
      listHostsGlobal: true,
      filesMode: "tree",
    });
    const store = createTopActionsStore();
    render(
      <TopActionsProvider store={store}>
        <ToolsInsetProvider value={inset("s1")}>
          <ToolActionsHost pane={false} />
        </ToolsInsetProvider>
        <ToolsInsetProvider value={inset("s2")}>
          <ToolActionsHost reserve={false} />
        </ToolsInsetProvider>
      </TopActionsProvider>,
    );
    expect(store.pick({ scope: "s1" })).toBeNull();
    expect(store.pick({ scope: "s2" })).not.toBeNull();
    expect(store.pick({ zones: ["tools"] })?.scope).toBeNull();
    const reserveHost = store.pick({ zones: ["tools"] });
    expect(reserveHost).not.toBe(store.pick({ scope: "s2" }));
  });
});
