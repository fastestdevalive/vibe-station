import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WallpaperEntry } from "@/api/types";
import { __resetBackgroundStoreForTests, getBackgroundStore } from "./backgroundStore";
import { gradientCss } from "./gradient";
import { thumbUrl } from "./thumbs";
import { WindowBackground } from "./WindowBackground";
import { __resetWallpaperImageForTests } from "./useWallpaperImage";

const { fetchBlobMock } = vi.hoisted(() => ({
  fetchBlobMock: vi.fn<(id: string, size: string) => Promise<Blob>>(),
}));

vi.mock("./wallpaperApi", () => ({ fetchWallpaperBlob: fetchBlobMock }));

const { peekMock, pinMock, getBakedUrlMock } = vi.hoisted(() => ({
  peekMock: vi.fn<(key: string) => string | null>(),
  pinMock: vi.fn<(key: string) => () => void>(),
  getBakedUrlMock: vi.fn<(key: string) => Promise<string | null>>(),
}));

// The real `useBakedWallpaper` runs on top of this: a memory hit is ready on the
// first render, a miss stays "baking" (this test never needs a finished bake).
vi.mock("./bake/bakeCache", () => ({
  peekBakedUrl: peekMock,
  pinBaked: pinMock,
  rememberBaked: vi.fn(),
  getBakedUrl: getBakedUrlMock,
  putBaked: vi.fn(),
}));

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

function renderAt(entry = "/") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <WindowBackground />
    </MemoryRouter>,
  );
}

function slides(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".window-bg__slide")];
}

function plainPicture(slide: HTMLElement): HTMLImageElement | null {
  // The plain picture is the slide's own child; the baked one lives inside `.wp-effect`.
  return slide.querySelector<HTMLImageElement>("img.wp-picture");
}

beforeEach(() => {
  __resetBackgroundStoreForTests();
  __resetWallpaperImageForTests();
  catalogRef.state = {
    status: "ready",
    wallpapers: [],
    ids: ["wp-001", "wp-002", "wp-003"],
  };
  fetchBlobMock.mockReset();
  peekMock.mockReset();
  pinMock.mockReset();
  getBakedUrlMock.mockReset();
  peekMock.mockReturnValue(null);
  pinMock.mockReturnValue(() => {});
  // Never resolves: every test here controls the full image itself.
  getBakedUrlMock.mockImplementation(() => new Promise<string | null>(() => {}));
  // Never resolves by default: asserts what paints BEFORE the full image lands.
  fetchBlobMock.mockImplementation(() => new Promise<Blob>(() => {}));
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetBackgroundStoreForTests();
  __resetWallpaperImageForTests();
});

describe("WindowBackground", () => {
  it("renders nothing for solid", () => {
    const store = getBackgroundStore();
    store.ensureRolled(["wp-001"], () => 0);
    store.patch({ mode: "solid" });

    const { container } = renderAt();

    expect(container.querySelector(".window-bg")).toBeNull();
  });

  it("draws the full image at the wallpaper's focal point", async () => {
    fetchBlobMock.mockResolvedValue(new Blob(["jpeg"]));
    getBackgroundStore().ensureRolled(["wp-003"], () => 0);

    const { container } = renderAt();

    await waitFor(() => {
      const img = plainPicture(slides(container)[0]!);
      expect(img?.src).toMatch(/^blob:/);
    });

    const img = plainPicture(slides(container)[0]!) as HTMLImageElement;
    expect(img.style.objectPosition).toBe("50% 82%");
  });

  it("placeholder thumb before full loads: framed centred, not at the focal point", async () => {
    getBackgroundStore().ensureRolled(["wp-003"], () => 0);

    const { container } = renderAt();

    const img = plainPicture(slides(container)[0]!) as HTMLImageElement;
    expect(img.src).toContain(thumbUrl("wp-003"));
    expect(img.style.objectPosition).toBe("50% 50%");
    expect(fetchBlobMock).toHaveBeenCalledWith("wp-003", "full", expect.anything());
  });

  it("first run fetches only the rolled pick, never the hash fallback", () => {
    // The app's hash pick here is `wp-001`; 0.5 rolls index 1, i.e. `wp-002`.
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    renderAt();

    const rolled = getBackgroundStore().getState();
    expect(rolled.rolled).toBe(true);
    expect(rolled.wallpaperId).toBe("wp-002");
    expect(fetchBlobMock).toHaveBeenCalledWith("wp-002", "full", expect.anything());
    expect(fetchBlobMock.mock.calls.length).toBeGreaterThan(0);
    for (const call of fetchBlobMock.mock.calls) expect(call[0]).toBe("wp-002");
  });

  it("keeps the layer non-interactive and behind the window", () => {
    getBackgroundStore().ensureRolled(["wp-001"], () => 0);

    const { container } = renderAt();

    const layer = container.querySelector(".window-bg") as HTMLElement;
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".window-bg__scrim")).not.toBeNull();
    expect(container.querySelector(".window-bg__fade")).not.toBeNull();
  });

  it("draws the chosen gradient on the fade", () => {
    const store = getBackgroundStore();
    store.ensureRolled(["wp-001"], () => 0);

    const { container } = renderAt();
    const fade = () => container.querySelector<HTMLElement>(".window-bg__fade")!;

    expect(fade().style.background).toBe(gradientCss("fade_to_theme"));

    act(() => store.patch({ gradient: "top_fade" }));
    expect(fade().style.background).toBe(gradientCss("top_fade"));

    act(() => store.patch({ gradient: "none" }));
    expect(fade().style.background).toBe("none");
  });

  it("keeps the old picture until the new one is ready, then dissolves it on top", async () => {
    const store = getBackgroundStore();
    store.ensureRolled(["wp-001"], () => 0);
    const pending = new Map<string, (blob: Blob) => void>();
    fetchBlobMock.mockImplementation(
      (id) => new Promise<Blob>((resolve) => pending.set(id, resolve)),
    );
    const revoke = vi.spyOn(URL, "revokeObjectURL");

    const { container } = renderAt();
    await waitFor(() => expect(pending.has("wp-001")).toBe(true));
    act(() => pending.get("wp-001")!(new Blob(["a"])));
    await waitFor(() => expect(plainPicture(slides(container)[0]!)?.src).toMatch(/^blob:/));

    const aSrc = plainPicture(slides(container)[0]!)!.src;
    expect(aSrc).toMatch(/^blob:/);

    act(() => store.patch({ wallpaperId: "wp-002" }));

    // B is mounted at opacity 0 while its picture loads; A is untouched underneath.
    const during = slides(container);
    expect(during).toHaveLength(2);
    expect(during[0]!.getAttribute("data-phase")).toBe("current");
    expect(during[1]!.getAttribute("data-phase")).toBe("incoming");
    expect(plainPicture(during[0]!)!.src).toBe(aSrc);
    expect(revoke).not.toHaveBeenCalledWith(aSrc);

    await waitFor(() => expect(pending.has("wp-002")).toBe(true));
    act(() => pending.get("wp-002")!(new Blob(["b"])));

    // Ready: B fades in, rendered after A so it paints on top.
    await waitFor(() => {
      const fading = slides(container);
      expect(fading).toHaveLength(2);
      expect(fading[1]!.getAttribute("data-phase")).toBe("fading");
    });

    const fading = slides(container);
    fireEvent.animationEnd(fading[1]!);

    await waitFor(() => expect(slides(container)).toHaveLength(1));
    expect(slides(container)[0]!.getAttribute("data-phase")).toBe("current");
    expect(plainPicture(slides(container)[0]!)!.src).not.toBe(aSrc);
  });

  it("switching to the same image does nothing", async () => {
    const store = getBackgroundStore();
    store.ensureRolled(["wp-001"], () => 0);
    fetchBlobMock.mockResolvedValue(new Blob(["a"]));

    const { container } = renderAt();
    await waitFor(() => expect(plainPicture(slides(container)[0]!)?.src).toMatch(/^blob:/));

    act(() => store.patch({ wallpaperId: "wp-001" }));

    expect(slides(container)).toHaveLength(1);
    expect(slides(container)[0]!.getAttribute("data-phase")).toBe("current");
  });

  it("no flash: switching back to a baked pair shows its baked picture on the first render", async () => {
    const store = getBackgroundStore();
    store.ensureRolled(["wp-003"], () => 0);
    store.patch({ texture: "dither" });
    fetchBlobMock.mockImplementation(async (id) => new Blob([id]));
    // Every pair is in the memory tier, as it would be after a page session of switching.
    peekMock.mockImplementation((key) => `blob:baked-${key.split("|")[0]}`);

    const { container } = renderAt();
    await waitFor(() =>
      expect(container.querySelector<HTMLImageElement>(".wp-effect img.wp-picture")?.src).toBe(
        "blob:baked-wp-003",
      ),
    );

    act(() => store.patch({ wallpaperId: "wp-002" }));
    await waitFor(() => expect(slides(container)).toHaveLength(2));
    await waitFor(() => expect(slides(container)[1]!.getAttribute("data-phase")).toBe("fading"));
    fireEvent.animationEnd(slides(container)[1]!);
    await waitFor(() => expect(slides(container)).toHaveLength(1));

    act(() => store.patch({ wallpaperId: "wp-003" }));

    // Synchronously after the switch back the returning slide already carries the
    // remembered bake: there is no plain-only frame for the wallpaper it shows.
    const bakes = [...container.querySelectorAll<HTMLImageElement>(".wp-effect img.wp-picture")].map(
      (img) => img.getAttribute("src"),
    );
    expect(bakes).toContain("blob:baked-wp-003");
  });
});
