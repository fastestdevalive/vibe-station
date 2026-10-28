import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  createTopActionsStore,
  HOST_PRIORITY,
  TopActionsProvider,
  useActionsHost,
  useIsReserveHost,
  type GroupZone,
} from "./TopActionsContext";

function els() {
  return {
    paneEl: document.createElement("span"),
    reserveEl: document.createElement("span"),
  };
}

describe("createTopActionsStore", () => {
  it("pick({zones}) takes the first zone that has a host", () => {
    const s = createTopActionsStore();
    const agent = s.register({ id: "a", zone: "agent", scope: null, priority: 0, ...els() });
    expect(s.pick({ zones: ["tools", "agent"] })?.id).toBe("a");
    s.register({ id: "t", zone: "tools", scope: "x", priority: 0, ...els() });
    expect(s.pick({ zones: ["tools", "agent"] })?.id).toBe("t");
    expect(s.pick({ zones: ["agent", "tools"] })?.id).toBe("a");
    expect(s.pick({ zones: ["canvas"] })).toBeNull();
    expect(s.pick({ zones: [] })).toBeNull();
    agent();
    expect(s.pick({ zones: ["agent"] })).toBeNull();
  });

  it("prefers highest priority, then lowest seq", () => {
    const s = createTopActionsStore();
    s.register({ id: "first", zone: "canvas", scope: null, priority: 1, ...els() });
    s.register({ id: "second", zone: "canvas", scope: null, priority: 1, ...els() });
    expect(s.pick({ zones: ["canvas"] })?.id).toBe("first");
    s.register({ id: "hi", zone: "canvas", scope: null, priority: 2, ...els() });
    expect(s.pick({ zones: ["canvas"] })?.id).toBe("hi");
  });

  it("pick({scope}) filters by scope and ignores zone", () => {
    const s = createTopActionsStore();
    s.register({ id: "a", zone: null, scope: "s1", priority: 0, ...els() });
    s.register({ id: "b", zone: "tools", scope: "s2", priority: 0, ...els() });
    expect(s.pick({ scope: "s1" })?.id).toBe("a");
    expect(s.pick({ scope: "s2" })?.id).toBe("b");
    expect(s.pick({ scope: "none" })).toBeNull();
    expect(s.pick({ zones: ["tools"] })?.id).toBe("b");
  });

  it("unregister removes and notifies; double unregister is a no-op", () => {
    const s = createTopActionsStore();
    const cb = vi.fn();
    s.subscribe(cb);
    const un = s.register({ id: "a", zone: "agent", scope: null, priority: 0, ...els() });
    expect(cb).toHaveBeenCalledTimes(1);
    un();
    un();
    expect(cb).toHaveBeenCalledTimes(2);
    expect(s.pick({ zones: ["agent"] })).toBeNull();
  });

  it("an unrelated register keeps the picked object identity", () => {
    const s = createTopActionsStore();
    s.register({ id: "a", zone: "agent", scope: null, priority: 0, ...els() });
    const before = s.pick({ zones: ["agent"] });
    s.register({ id: "c", zone: "canvas", scope: null, priority: 0, ...els() });
    expect(s.pick({ zones: ["agent"] })).toBe(before);
    expect(s.pick({ zones: ["agent"] })).toBe(s.pick({ zones: ["agent"] }));
  });
});

describe("host priority flips", () => {
  it("list open/close: the group goes to the list header, never stays on a re-registered Files bar, and returns on close", () => {
    const s = createTopActionsStore();
    const bar = els();
    // List closed: the Files bar hosts the group.
    let offBar = s.register({ id: "bar", zone: "tools", scope: null, priority: HOST_PRIORITY.default, ...bar });
    expect(s.pick({ zones: ["tools"] })?.id).toBe("bar");
    // List opens: the bar re-registers as the fallback (a NEWER seq than any header registered later does not matter)
    // and the mode header registers at the default priority.
    offBar();
    offBar = s.register({ id: "bar", zone: "tools", scope: null, priority: HOST_PRIORITY.filesBarFallback, ...bar });
    const offHeader = s.register({ id: "header", zone: "tools", scope: null, priority: HOST_PRIORITY.default, ...els() });
    expect(s.pick({ zones: ["tools"] })?.id).toBe("header");
    // The fallback still carries the group if the header never mounts a host (mode without a header host).
    offHeader();
    expect(s.pick({ zones: ["tools"] })?.id).toBe("bar");
    // List closes again: the bar is the only host at the default priority.
    offBar();
    s.register({ id: "bar", zone: "tools", scope: null, priority: HOST_PRIORITY.default, ...bar });
    expect(s.pick({ zones: ["tools"] })?.id).toBe("bar");
  });

  it("canvas toolbar beats canvas tile beats default beats the Files-bar fallback", () => {
    const p = HOST_PRIORITY;
    expect(p.canvasToolbar).toBeGreaterThan(p.canvasTile);
    expect(p.canvasTile).toBeGreaterThan(p.default);
    expect(p.default).toBeGreaterThan(p.filesBarFallback);
  });
});

describe("reserve zones and reserveHost", () => {
  it("the pick follows the zones; no zones = no reserve host", () => {
    const s = createTopActionsStore();
    s.register({ id: "a", zone: "agent", scope: null, priority: 0, ...els() });
    s.register({ id: "t", zone: "tools", scope: "x", priority: 0, ...els() });
    expect(s.reserveHost()).toBeNull();
    s.setReserveZones(["tools", "agent"]);
    expect(s.reserveHost()?.id).toBe("t");
    s.setReserveZones(["agent"]);
    expect(s.reserveHost()?.id).toBe("a");
    s.setReserveZones(["canvas"]);
    expect(s.reserveHost()).toBeNull();
    s.setReserveZones([]);
    expect(s.reserveHost()).toBeNull();
  });

  it("emits only when the zones change", () => {
    const s = createTopActionsStore();
    const cb = vi.fn();
    s.subscribe(cb);
    s.setReserveZones(["tools", "agent"]);
    expect(cb).toHaveBeenCalledTimes(1);
    s.setReserveZones(["tools", "agent"]);
    expect(cb).toHaveBeenCalledTimes(1);
    s.setReserveZones(["agent"]);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("useIsReserveHost is true for exactly one host and follows the registry", () => {
    const s = createTopActionsStore();
    const a = els();
    const t = els();
    const wrapper = ({ children }: { children: ReactNode }) => <TopActionsProvider store={s}>{children}</TopActionsProvider>;
    s.register({ id: "a", zone: "agent", scope: null, priority: 0, ...a });
    s.setReserveZones(["tools", "agent"]);
    const flags = () => ({
      a: renderHook(() => useIsReserveHost(a.reserveEl), { wrapper }).result.current,
      t: renderHook(() => useIsReserveHost(t.reserveEl), { wrapper }).result.current,
      none: renderHook(() => useIsReserveHost(null), { wrapper }).result.current,
    });
    expect(flags()).toEqual({ a: true, t: false, none: false });
    act(() => {
      s.register({ id: "t", zone: "tools", scope: null, priority: 0, ...t });
    });
    expect(flags()).toEqual({ a: false, t: true, none: false });
  });

  it("useIsReserveHost is false without a provider", () => {
    const { result } = renderHook(() => useIsReserveHost(document.createElement("span")));
    expect(result.current).toBe(false);
  });
});

describe("zone types", () => {
  it("every zone is a GroupZone (the rail pseudo-zone is gone)", () => {
    const ok: GroupZone[] = ["tools", "agent", "canvas"];
    expect(ok).toHaveLength(3);
    // @ts-expect-error "rail" no longer exists: the rail head hosts nothing.
    const bad: GroupZone = "rail";
    void bad;
  });
});

describe("useActionsHost", () => {
  it("returns null without a provider", () => {
    const { result } = renderHook(() => useActionsHost({ zones: ["agent"] }));
    expect(result.current).toBeNull();
  });
});
