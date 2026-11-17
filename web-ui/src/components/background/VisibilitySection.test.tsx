import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";
import { baseUrl } from "@/api/client";
import { VisibilitySection } from "./VisibilitySection";
import { __resetBackgroundStoreForTests, defaultPrefs, getBackgroundStore } from "./backgroundStore";

// Track B's tests must not depend on Track A's disclosure internals: a trivial
// stand-in that renders children only while `open` is enough here.
vi.mock("@/components/background/CollapsibleSection", () => ({
  CollapsibleSection: ({
    title,
    summary,
    open,
    onToggle,
    children,
  }: {
    id: string;
    title: string;
    summary?: ReactNode;
    open: boolean;
    onToggle: () => void;
    children: ReactNode;
  }) => (
    <section>
      <h3>
        <button type="button" aria-expanded={open} onClick={onToggle}>
          {title}
          <span aria-hidden="true">{summary}</span>
        </button>
      </h3>
      {open ? <div role="region">{children}</div> : null}
    </section>
  ),
}));

beforeEach(() => {
  localStorage.clear();
  __resetBackgroundStoreForTests();
});

describe("VisibilitySection", () => {
  it("closed by default", () => {
    render(<VisibilitySection />);
    expect(screen.getByRole("button", { name: "Visibility" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
    expect(getBackgroundStore().getState().sections.visibility).toBe(false);
  });

  it("toggling the section writes `sections.visibility` and reveals the sliders", () => {
    render(<VisibilitySection />);
    fireEvent.click(screen.getByRole("button", { name: "Visibility" }));
    expect(getBackgroundStore().getState().sections.visibility).toBe(true);
    expect(screen.getAllByRole("slider")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Visibility" }));
    expect(getBackgroundStore().getState().sections.visibility).toBe(false);
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
  });

  it("slider writes store", () => {
    const store = getBackgroundStore();
    store.setSection("visibility", true);
    render(<VisibilitySection />);

    fireEvent.change(screen.getByRole("slider", { name: "Empty chats" }), { target: { value: "50" } });
    expect(store.getState().emptyVisibility).toBeCloseTo(0.5);

    fireEvent.change(screen.getByRole("slider", { name: "Sessions" }), { target: { value: "60" } });
    expect(store.getState().sessionVisibility).toBeCloseTo(0.6);

    fireEvent.change(screen.getByRole("slider", { name: "Sidebar and bars transparency" }), {
      target: { value: "40" },
    });
    expect(store.getState().chromeOpacity).toBe(0.6);
  });

  it("aria-valuetext percent", () => {
    const store = getBackgroundStore();
    store.setSection("visibility", true);
    render(<VisibilitySection />);

    const empty = screen.getByRole("slider", { name: "Empty chats" });
    const sessions = screen.getByRole("slider", { name: "Sessions" });
    const chrome = screen.getByRole("slider", { name: "Sidebar and bars transparency" });

    // Store defaults: 0.90 / 0.20 / 0.72 → the chrome row shows 28% transparency.
    expect(empty.getAttribute("aria-valuetext")).toBe("90%");
    expect(sessions.getAttribute("aria-valuetext")).toBe("20%");
    expect(chrome.getAttribute("aria-valuetext")).toBe("28% transparent");

    fireEvent.change(empty, { target: { value: "20" } });
    expect(empty.getAttribute("aria-valuetext")).toBe("20%");
  });

  it("the chrome row is a 0-60%, step-2 transparency slider whose readout and summary agree", () => {
    const store = getBackgroundStore();
    store.setSection("visibility", true);
    render(<VisibilitySection />);

    const chrome = screen.getByRole("slider", { name: "Sidebar and bars transparency" });
    expect(chrome.getAttribute("min")).toBe("0");
    expect(chrome.getAttribute("max")).toBe("60");
    expect(chrome.getAttribute("step")).toBe("2");
    expect(chrome.parentElement?.querySelector(".bg-vis__value")?.textContent).toBe("28%");
    expect(screen.getByRole("button", { name: "Visibility" }).textContent).toContain(
      "Bars 28% transparent",
    );

    fireEvent.change(chrome, { target: { value: "40" } });
    expect(store.getState().chromeOpacity).toBe(0.6);
    expect(chrome.getAttribute("aria-valuetext")).toBe("40% transparent");

    fireEvent.change(chrome, { target: { value: "0" } });
    expect(store.getState().chromeOpacity).toBe(1);
    expect(chrome.getAttribute("aria-valuetext")).toBe("0% transparent");

    fireEvent.change(chrome, { target: { value: "60" } });
    expect(store.getState().chromeOpacity).toBe(0.4);
    expect(chrome.getAttribute("aria-valuetext")).toBe("60% transparent");
  });

  it("an out-of-range stored chrome opacity reads as 0% transparent without rewriting storage", () => {
    const key = `vst.background.v1:${new URL(baseUrl(), location.href).origin}`;
    const seeded = { ...defaultPrefs(), chromeOpacity: 1.4 };
    seeded.sections = { ...seeded.sections, visibility: true };
    const raw = JSON.stringify(seeded);
    localStorage.setItem(key, raw);

    render(<VisibilitySection />);

    expect(
      screen.getByRole("slider", { name: "Sidebar and bars transparency" }).getAttribute("aria-valuetext"),
    ).toBe("0% transparent");
    expect(localStorage.getItem(key)).toBe(raw);
  });
});
