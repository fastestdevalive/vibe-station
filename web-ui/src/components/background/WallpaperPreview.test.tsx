import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WallpaperEntry } from "@/api/types";
import type { BakeInput } from "./bake/bakeClient";
import { __resetBackgroundStoreForTests, getBackgroundStore } from "./backgroundStore";
import { gradientCss } from "./gradient";
import { Picker } from "./Picker";
import { VisibilitySection } from "./VisibilitySection";
import { useBackground } from "./useBackground";
import { __resetWallpaperImageForTests } from "./useWallpaperImage";

const { fetchBlobMock, bakeMock } = vi.hoisted(() => ({
  fetchBlobMock: vi.fn<() => Promise<Blob>>(),
  bakeMock: vi.fn<(input: BakeInput) => Promise<Blob>>(),
}));

vi.mock("./wallpaperApi", () => ({ fetchWallpaperBlob: fetchBlobMock }));
vi.mock("./bake/bakeClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bake/bakeClient")>();
  return {
    ...actual,
    bake: bakeMock,
  };
});

const { catalogRef } = vi.hoisted(() => ({
  catalogRef: {
    state: {
      status: "ready" as "loading" | "ready" | "unavailable",
      wallpapers: [] as WallpaperEntry[],
      ids: [] as string[],
    },
  },
}));

vi.mock("./useWallpaperCatalog", () => ({
  useWallpaperCatalog: () => catalogRef.state,
}));

const IDS = ["wp-001", "wp-002", "wp-003"];

function entries(ids: string[]): WallpaperEntry[] {
  return ids.map((id) => ({
    id,
    name: id,
    category: "places",
    mode: "any",
    url: `https://images.rawpixel.com/${id}.jpg`,
    thumbnailUrl: `https://images.rawpixel.com/${id}.jpg`,
    width: 683,
    height: 1024,
    license: "CC0",
  }));
}

/** The Picker is the preview's only mount, so these drive the real integration. */
function renderPicker(): HTMLElement {
  return render(<Picker mode="app" />).container;
}

function preview(root: HTMLElement): HTMLElement {
  const el = root.querySelector<HTMLElement>(".wp-preview");
  if (el === null) throw new Error("no preview rendered");
  return el;
}

function previewVar(root: HTMLElement, name: string): string {
  return preview(root).style.getPropertyValue(name);
}

/** Calls the wallpaper hook so `<html>` carries the same `--wp-*` vars the preview shows. */
function WindowVarsHarness(): null {
  useBackground();
  return null;
}

/** The public path under test: slider → store → preview root and real-window root. */
function renderPreviewAndWindow(): HTMLElement {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <VisibilitySection />
      <Picker mode="app" />
      <WindowVarsHarness />
    </MemoryRouter>,
  ).container;
}

beforeEach(() => {
  __resetBackgroundStoreForTests();
  __resetWallpaperImageForTests();
  fetchBlobMock.mockReset();
  bakeMock.mockReset();
  bakeMock.mockImplementation(async () => new Blob(["baked"]));
  // Never resolves: the bundled thumb is what paints, like the window's first frame.
  fetchBlobMock.mockImplementation(() => new Promise<Blob>(() => {}));
  catalogRef.state = { status: "ready", wallpapers: entries(IDS), ids: IDS };
});

afterEach(() => {
  __resetBackgroundStoreForTests();
  __resetWallpaperImageForTests();
});

describe("WallpaperPreview", () => {
  it("draws the mini window at the selected view's visibility", () => {
    const root = renderPicker();

    expect(previewVar(root, "--wp-vis")).toBe("0.9");
    const mini = root.querySelector<HTMLElement>(".wp-mini");
    expect(mini).not.toBeNull();
    expect(mini!.getAttribute("aria-hidden")).toBe("true");
    expect(mini!.querySelector(".wp-mini__lights")).not.toBeNull();
    expect(mini!.querySelectorAll(".wp-mini__light")).toHaveLength(3);
    expect(mini!.querySelector(".wp-mini__tabs")?.textContent).toContain("Agent");
    expect(mini!.querySelector(".wp-mini__title")?.textContent).toBe("What should we build?");
  });

  it("the Empty chat | Session switch selects the visibility value it renders", () => {
    const root = renderPicker();

    fireEvent.click(screen.getByRole("radio", { name: "Session" }));
    expect(previewVar(root, "--wp-vis")).toBe("0.2");
    // The session view swaps the title for transcript cards.
    expect(root.querySelector(".wp-mini__title")).toBeNull();
    expect(root.querySelectorAll(".wp-mini__card")).toHaveLength(2);

    fireEvent.click(screen.getByRole("radio", { name: "Empty chat" }));
    expect(previewVar(root, "--wp-vis")).toBe("0.9");
    expect(root.querySelector(".wp-mini__title")).not.toBeNull();
  });

  it("the visibility slider reaches the preview's scrim", () => {
    const store = getBackgroundStore();
    const root = renderPicker();

    act(() => store.patch({ emptyVisibility: 0.5 }));
    expect(previewVar(root, "--wp-vis")).toBe("0.5");

    fireEvent.click(screen.getByRole("radio", { name: "Session" }));
    act(() => store.patch({ sessionVisibility: 0.2 }));
    expect(previewVar(root, "--wp-vis")).toBe("0.2");
  });

  it("the stored chrome opacity reaches the mini window's glass", () => {
    const store = getBackgroundStore();
    const root = renderPicker();

    act(() => store.patch({ chromeOpacity: 0.9 }));
    expect(previewVar(root, "--wp-chrome-alpha")).toBe("90%");
  });

  it("Sidebar and bars transparency slider drives preview and window alike", () => {
    const store = getBackgroundStore();
    store.ensureRolled(IDS, () => 0);
    act(() => store.setSection("visibility", true));

    const root = renderPreviewAndWindow();
    const chrome = screen.getByRole("slider", { name: "Sidebar and bars transparency" });
    const windowAlpha = () => document.documentElement.style.getPropertyValue("--wp-chrome-alpha");

    expect(chrome.getAttribute("aria-valuetext")).toBe("28% transparent");
    expect(previewVar(root, "--wp-chrome-alpha")).toBe("72%");
    expect(windowAlpha()).toBe("72%");

    fireEvent.change(chrome, { target: { value: "40" } });

    expect(chrome.getAttribute("aria-valuetext")).toBe("40% transparent");
    expect(previewVar(root, "--wp-chrome-alpha")).toBe("60%");
    expect(windowAlpha()).toBe("60%");
  });

  it("intensity is the baked layer's live opacity, not a re-bake", () => {
    const store = getBackgroundStore();
    const root = renderPicker();

    act(() => store.patch({ texture: "grain" }));
    const effect = () => root.querySelector<HTMLElement>(".wp-effect");
    expect(effect()).not.toBeNull();

    act(() => store.patch({ intensity: 0.3 }));
    expect(effect()!.style.opacity).toBe("0.3");

    act(() => store.patch({ intensity: 0.8 }));
    expect(effect()!.style.opacity).toBe("0.8");
  });

  it("a texture change swaps the live layer", () => {
    const store = getBackgroundStore();
    const root = renderPicker();

    act(() => store.patch({ texture: "frost" }));
    expect(root.querySelector(".wp-frost")).not.toBeNull();
  });

  it("the chosen gradient draws on the one scrim + fade pair", () => {
    const store = getBackgroundStore();
    const root = renderPicker();
    const fade = () => root.querySelector<HTMLElement>(".wp-preview .window-bg__fade");

    expect(fade()!.style.background).toBe(gradientCss("fade_to_theme"));
    expect(root.querySelectorAll(".wp-preview .window-bg__scrim")).toHaveLength(1);

    act(() => store.patch({ gradient: "side_fade" }));
    expect(fade()!.style.background).toBe(gradientCss("side_fade"));
  });

  it("solid draws no picture and an opaque chrome", () => {
    const store = getBackgroundStore();
    const root = renderPicker();

    act(() => store.patch({ mode: "solid" }));

    expect(root.querySelector(".wp-picture")).toBeNull();
    expect(root.querySelector(".window-bg__scrim")).toBeNull();
    expect(previewVar(root, "--wp-chrome-alpha")).toBe("100%");
    // The miniature is still the window: chrome over the theme colours.
    expect(root.querySelector(".wp-mini")).not.toBeNull();
  });

  it("the miniature is decoration: only the two switch radios are focusable", () => {
    const root = renderPicker();

    expect(root.querySelector(".wp-mini")!.querySelector("button, a, [tabindex]")).toBeNull();

    const focusable = [...root.querySelectorAll<HTMLElement>(".wp-preview-frame button, .wp-preview-frame a, .wp-preview-frame [tabindex]")];
    expect(focusable).toHaveLength(2);
    expect(focusable.map((el) => el.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(focusable.map((el) => el.textContent)).toEqual(["Empty chat", "Session"]);
  });

  it("the preview never bakes at window size", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 320,
      height: 180,
      top: 0,
      left: 0,
      bottom: 180,
      right: 320,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    const store = getBackgroundStore();
    act(() => store.patch({ texture: "dither" }));
    renderPicker();

    await waitFor(() => expect(bakeMock).toHaveBeenCalled());
    for (const call of bakeMock.mock.calls) {
      expect(call[0].width).toBeLessThanOrEqual(640);
    }
  });
});
