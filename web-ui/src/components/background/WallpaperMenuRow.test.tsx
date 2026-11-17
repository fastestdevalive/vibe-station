import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WallpaperEntry } from "@/api/types";
import {
  __resetBackgroundStoreForTests,
  getBackgroundStore,
  type ScopeKey,
} from "./backgroundStore";
import { stableWallpaperIndex } from "./hash";
import { useScopePickerStore } from "./scopePickerStore";
import { WallpaperMenuRow } from "./WallpaperMenuRow";

const { catalogRef } = vi.hoisted(() => ({
  catalogRef: {
    state: {
      status: "loading" as "loading" | "ready" | "unavailable",
      wallpapers: [] as WallpaperEntry[],
      ids: [] as string[],
    },
  },
}));

vi.mock("./useWallpaperCatalog", () => ({
  useWallpaperCatalog: () => catalogRef.state,
}));

const IDS = ["wp-001", "wp-002", "wp-003"];
const NAMES: Record<string, string> = {
  "wp-001": "Fog Mountain",
  "wp-002": "Stars Dark",
  "wp-003": "Clouds Dusk",
};
const SCOPE: ScopeKey = "worktree:w1";

function entries(ids: string[]): WallpaperEntry[] {
  return ids.map((id) => ({
    id,
    name: NAMES[id] ?? id,
    category: "places",
    mode: "any",
    url: `https://images.rawpixel.com/${id}.jpg`,
    thumbnailUrl: `https://images.rawpixel.com/${id}.jpg`,
    width: 683,
    height: 1024,
    license: "CC0",
  }));
}

function readyCatalog(ids: string[] = IDS) {
  catalogRef.state = { status: "ready", wallpapers: entries(ids), ids };
}

function LocationDisplay() {
  return <span data-testid="loc">{useLocation().pathname}</span>;
}

function renderRow(onDone = vi.fn()) {
  render(
    <MemoryRouter>
      <WallpaperMenuRow scope={SCOPE} label="wallpaper-effects" kind="worktree" onDone={onDone} />
      <LocationDisplay />
    </MemoryRouter>,
  );
  return onDone;
}

beforeEach(() => {
  __resetBackgroundStoreForTests();
  useScopePickerStore.setState({ open: null });
  readyCatalog();
});

afterEach(() => {
  __resetBackgroundStoreForTests();
  useScopePickerStore.setState({ open: null });
});

describe("WallpaperMenuRow", () => {
  it("default shows resolved name", () => {
    getBackgroundStore().writeSeedIfAbsent(SCOPE, "wp-002");

    renderRow();

    expect(screen.getByRole("menuitem", { name: /Wallpaper/ })).toHaveTextContent(
      "Default · Stars Dark",
    );
  });

  it("default falls back to the hash pick when the scope has no seed", () => {
    const expected = IDS[stableWallpaperIndex("w1", IDS.length)]!;

    renderRow();

    expect(screen.getByRole("menuitem", { name: /Wallpaper/ })).toHaveTextContent(
      `Default · ${NAMES[expected]}`,
    );
  });

  it("override shows its name", () => {
    getBackgroundStore().setOverride(SCOPE, { kind: "id", id: "wp-003" });

    renderRow();

    expect(screen.getByRole("menuitem", { name: /Wallpaper/ })).toHaveTextContent("Clouds Dusk");
  });

  it("override none shows None", () => {
    getBackgroundStore().setOverride(SCOPE, { kind: "none" });

    renderRow();

    expect(screen.getByRole("menuitem", { name: /Wallpaper/ })).toHaveTextContent("None");
  });

  it("renders Default without a loaded catalog", () => {
    catalogRef.state = { status: "loading", wallpapers: [], ids: [] };

    renderRow();

    const row = screen.getByRole("menuitem", { name: /Wallpaper/ });
    expect(row).toHaveTextContent("Default");
    expect(row).not.toHaveTextContent("·");
  });

  it("solid app shows Off and navigates to settings", async () => {
    const user = userEvent.setup();
    getBackgroundStore().patch({ mode: "solid" });
    const onDone = renderRow();

    expect(screen.getByRole("menuitem", { name: /Wallpaper/ })).toHaveTextContent("Off");
    expect(screen.getByText("Background is Solid · Turn on")).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: /Wallpaper/ }));

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("loc")).toHaveTextContent("/settings/background");
    expect(useScopePickerStore.getState().open).toBeNull();
  });

  it("clicking the row opens the scope picker and closes the menu", async () => {
    const user = userEvent.setup();
    const onDone = renderRow();

    await user.click(screen.getByRole("menuitem", { name: /Wallpaper/ }));

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(useScopePickerStore.getState().open).toEqual({
      scope: SCOPE,
      label: "wallpaper-effects",
      kind: "worktree",
    });
    expect(screen.getByTestId("loc")).toHaveTextContent("/");
  });

  it("reset only while overridden", () => {
    renderRow();
    expect(screen.queryByRole("menuitem", { name: /Reset to default/ })).toBeNull();

    act(() => getBackgroundStore().setOverride(SCOPE, { kind: "id", id: "wp-002" }));

    // Agents keep their own wallpapers, so this seedless scope resets to its pick,
    // not to the app background (R2F-06).
    expect(screen.getByRole("menuitem", { name: /Reset to default/ })).toHaveTextContent(
      "Use the wallpaper picked for this worktree",
    );
  });

  it("reset follows the app background when agents share it", () => {
    const store = getBackgroundStore();
    store.patch({ agentWallpapers: false });
    store.setOverride(SCOPE, { kind: "id", id: "wp-002" });

    renderRow();

    expect(screen.getByRole("menuitem", { name: /Reset to default/ })).toHaveTextContent(
      "Follow the app background",
    );
  });

  it("reset copy mentions the seed when the scope has one", () => {
    const store = getBackgroundStore();
    store.writeSeedIfAbsent(SCOPE, "wp-002");
    store.setOverride(SCOPE, { kind: "id", id: "wp-003" });

    renderRow();

    expect(screen.getByRole("menuitem", { name: /Reset to default/ })).toHaveTextContent(
      "Use the wallpaper this worktree started with",
    );
  });

  it("B off: Default names the app background, not the scope's hash pick", () => {
    getBackgroundStore().patch({ agentWallpapers: false, wallpaperId: "wp-002" });

    renderRow();

    expect(screen.getByRole("menuitem", { name: /Wallpaper/ })).toHaveTextContent(
      "Default · Stars Dark",
    );
  });

  it("overridden row shows the reset icon and the full source sub-line", () => {
    const store = getBackgroundStore();
    store.writeSeedIfAbsent(SCOPE, "wp-002");
    store.setOverride(SCOPE, { kind: "id", id: "wp-003" });

    renderRow();

    const reset = screen.getByRole("menuitem", { name: /Reset to default/ });
    // Design `ScopePicker.dc.html`: a rotate-ccw icon, label above the sub-line.
    expect(reset.querySelector("svg.lucide-rotate-ccw")).not.toBeNull();
    expect(reset.querySelector(".wp-menu-row__stack .wp-menu-row__label")?.textContent).toBe(
      "Reset to default",
    );
    // The sub-line is its own wrapping line, not truncated inline.
    expect(reset.querySelector(".wp-menu-row__stack .wp-menu-row__sub")?.textContent).toBe(
      "Use the wallpaper this worktree started with",
    );
  });

  it("reset clears override", async () => {
    const user = userEvent.setup();
    const store = getBackgroundStore();
    store.setOverride(SCOPE, { kind: "id", id: "wp-002" });
    renderRow();

    await user.click(screen.getByRole("menuitem", { name: /Reset to default/ }));

    expect(store.getState().overrides[SCOPE]).toBeUndefined();
    expect(screen.queryByRole("menuitem", { name: /Reset to default/ })).toBeNull();
  });
});
