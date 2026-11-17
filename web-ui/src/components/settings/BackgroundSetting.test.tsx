import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";
import { BackgroundSetting } from "./BackgroundSetting";
import { __resetBackgroundStoreForTests, getBackgroundStore } from "@/components/background/backgroundStore";

// Track B's unit tests stand in for Track A's components (see the Picker and
// CollapsibleSection contracts in the plan); the real join is covered by
// BackgroundSetting.integration.test.tsx.
vi.mock("@/components/background/Picker", () => ({
  Picker: ({ mode }: { mode: string }) => <div data-testid="bg-picker" data-mode={mode} />,
}));

vi.mock("@/components/background/CollapsibleSection", () => ({
  CollapsibleSection: ({
    title,
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

describe("BackgroundSetting", () => {
  it("renders picker with sections closed", () => {
    render(<BackgroundSetting />);
    expect(screen.getByTestId("bg-picker").getAttribute("data-mode")).toBe("app");
    expect(screen.getByText("Background")).toBeInTheDocument();
    expect(getBackgroundStore().getState().sections.visibility).toBe(false);
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
  });

  it("header uses the design copy, so the mode caption is not duplicated", () => {
    render(<BackgroundSetting />);

    expect(
      screen.getByText("Solid, or one wallpaper behind the whole window with a texture over it."),
    ).toBeInTheDocument();
    // The picker's mode caption is the only place the old header sentence lives.
    expect(screen.getAllByText(/one wallpaper behind the whole window/i)).toHaveLength(1);
  });

  it("the per-agent switch keeps role/aria on a 44px-capable hit area", () => {
    render(<BackgroundSetting />);

    const toggle = screen.getByRole("switch", { name: "Own wallpaper per agent" });
    expect(toggle.className).toContain("bg-own-switch");
    expect(toggle.querySelector(".bg-own-switch__track")).not.toBeNull();
  });

  it("toggle writes agentWallpapers", () => {
    render(<BackgroundSetting />);
    const toggle = screen.getByRole("switch", { name: "Own wallpaper per agent" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);
    expect(getBackgroundStore().getState().agentWallpapers).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    expect(getBackgroundStore().getState().agentWallpapers).toBe(true);
  });

  it("caption switches with toggle", () => {
    render(<BackgroundSetting />);
    expect(screen.getByText("Each new agent gets a random wallpaper and keeps it in its worktree.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Own wallpaper per agent" }));
    expect(screen.getByText("Agents use the app background.")).toBeInTheDocument();
    expect(
      screen.queryByText("Each new agent gets a random wallpaper and keeps it in its worktree."),
    ).toBeNull();
  });

  it("pointer to options menu present (design copy, R1F-08)", () => {
    render(<BackgroundSetting />);
    expect(
      screen.getByText("For one worktree or project, open its options menu and choose Wallpaper."),
    ).toBeInTheDocument();
  });
});
