import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WallpaperEntry } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { __resetBackgroundStoreForTests, getBackgroundStore } from "./backgroundStore";
import { stableWallpaperIndex } from "./hash";
import type { ScreenKind } from "./resolveWallpaper";
import { TEXTURES } from "./textureCatalog";
import { useBackground } from "./useBackground";

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

function setCatalog(ids: string[]): void {
  catalogRef.state = {
    status: "ready",
    wallpapers: ids.map((id) => ({
      id,
      name: id,
      category: "places",
      mode: "any",
      url: `https://images.rawpixel.com/${id}.jpg`,
      thumbnailUrl: `https://images.rawpixel.com/${id}.jpg`,
      width: 683,
      height: 1024,
    })),
    ids,
  };
}

function wrapper(entry: string) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
  );
}

function renderBackground(entry: string, kindOverride?: ScreenKind) {
  return renderHook(() => useBackground(kindOverride), { wrapper: wrapper(entry) });
}

beforeEach(() => {
  __resetBackgroundStoreForTests();
  catalogRef.state = { status: "loading", wallpapers: [], ids: [] };
  useServerStore.setState({
    sessions: [
      {
        id: "d2",
        worktreeId: "w1",
        projectId: "p1",
        modeId: null,
        type: "agent",
        isMain: false,
        state: "idle",
        lifecycleState: "idle",
        tmuxName: "tmux-d2",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetBackgroundStoreForTests();
  useServerStore.setState({ sessions: [] });
});

describe("useBackground", () => {
  it("rolls once when catalog ready", () => {
    setCatalog(["wp-001", "wp-002"]);
    const { rerender } = renderBackground("/");

    const rolled = getBackgroundStore().getState();
    expect(rolled.rolled).toBe(true);
    expect(["wp-001", "wp-002"]).toContain(rolled.wallpaperId);
    expect(TEXTURES.map((t) => t.id)).toContain(rolled.texture);

    setCatalog(["wp-003"]);
    rerender();

    expect(getBackgroundStore().getState().wallpaperId).toBe(rolled.wallpaperId);
    expect(getBackgroundStore().getState().texture).toBe(rolled.texture);
  });

  it("first run never returns the hash pick, only the rolled one", () => {
    const ids = Array.from({ length: 26 }, (_, i) => `wp-${String(i + 1).padStart(3, "0")}`);
    setCatalog(ids);
    const hashPick = ids[stableWallpaperIndex("app", ids.length)]!;
    // The roll uses Math.random; 0.5 picks index 13 (`wp-014`), not the hash pick.
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    // Record what the hook returns on EVERY render, not just the settled one.
    const seen: Array<string | null> = [];
    renderHook(
      () => {
        const view = useBackground();
        seen.push(view.imageId);
        return view;
      },
      { wrapper: wrapper("/") },
    );

    const rolled = getBackgroundStore().getState();
    expect(rolled.rolled).toBe(true);
    expect(rolled.wallpaperId).toBe("wp-014");
    expect(rolled.wallpaperId).not.toBe(hashPick);

    const painted = seen.filter((id): id is string => id !== null);
    expect(painted.length).toBeGreaterThan(0);
    // The first image the hook ever hands out is the rolled pick…
    expect(painted[0]).toBe(rolled.wallpaperId);
    // …and the hash fallback never appears, not even for one render.
    expect(seen).not.toContain(hashPick);
  });

  it("sets data-wallpaper on and --wp-chrome-alpha", () => {
    const store = getBackgroundStore();
    store.ensureRolled(["wp-001"], () => 0);
    setCatalog(["wp-001"]);

    renderBackground("/");

    const root = document.documentElement;
    expect(root.dataset.wallpaper).toBe("on");
    expect(root.style.getPropertyValue("--wp-chrome-alpha")).toBe("72%");
    expect(root.style.getPropertyValue("--wp-vis")).toBe("0.2");
  });

  it("solid mode sets data-wallpaper off", () => {
    const store = getBackgroundStore();
    store.ensureRolled(["wp-001"], () => 0);
    store.patch({ mode: "solid" });
    setCatalog(["wp-001"]);

    const { result } = renderBackground("/");

    expect(result.current.imageId).toBeNull();
    expect(document.documentElement.dataset.wallpaper).toBe("off");
    // Requirement 8: every alpha is 100% when no wallpaper paints.
    expect(document.documentElement.style.getPropertyValue("--wp-chrome-alpha")).toBe("100%");
  });

  it("removes root attrs on unmount", () => {
    const store = getBackgroundStore();
    store.ensureRolled(["wp-001"], () => 0);
    setCatalog(["wp-001"]);

    const { unmount } = renderBackground("/");
    expect(document.documentElement.dataset.wallpaper).toBe("on");

    unmount();

    const root = document.documentElement;
    expect(root.dataset.wallpaper).toBeUndefined();
    expect(root.style.getPropertyValue("--wp-chrome-alpha")).toBe("");
    expect(root.style.getPropertyValue("--wp-vis")).toBe("");
  });

  it("writes hash seed once for a seedless worktree", () => {
    const ids = ["wp-001", "wp-002", "wp-003"];
    getBackgroundStore().ensureRolled(ids, () => 0);
    setCatalog(ids);

    const { rerender } = renderBackground("/worktree/w1");

    const expected = ids[stableWallpaperIndex("w1", ids.length)];
    expect(getBackgroundStore().getState().seeds["worktree:w1"]).toBe(expected);

    // A user override does not touch the seed; a re-render never rewrites it.
    getBackgroundStore().setOverride("worktree:w1", { kind: "id", id: "wp-003" });
    rerender();
    expect(getBackgroundStore().getState().seeds["worktree:w1"]).toBe(expected);
  });

  it("does not seed a worktree while agents share the app background", () => {
    const ids = ["wp-001", "wp-002", "wp-003"];
    const store = getBackgroundStore();
    store.ensureRolled(ids, () => 0);
    store.patch({ agentWallpapers: false });
    setCatalog(ids);

    renderBackground("/worktree/w1");

    expect(getBackgroundStore().getState().seeds["worktree:w1"]).toBeUndefined();
  });

  it("claims own id for a new-worktree draft", () => {
    const ids = ["wp-001", "wp-002", "wp-003"];
    getBackgroundStore().ensureRolled(ids, () => 0);
    setCatalog(ids);

    renderBackground("/draft/new");

    expect(getBackgroundStore().getState().drafts.new).toBe(ids[stableWallpaperIndex("new", ids.length)]);
  });

  it("tab draft claims nothing", () => {
    const ids = ["wp-001", "wp-002", "wp-003"];
    getBackgroundStore().ensureRolled(ids, () => 0);
    setCatalog(ids);

    const { result } = renderBackground("/draft/d2");

    expect(getBackgroundStore().getState().drafts).toEqual({});
    // …and still shows the worktree's wallpaper, via its hash pick.
    expect(result.current.imageId).toBe(ids[stableWallpaperIndex("w1", ids.length)]);
  });

  it("writes the root variables before the first paint (layout effect), so a new layer never starts clear", () => {
    const ids = ["wp-001", "wp-002"];
    getBackgroundStore().ensureRolled(ids, () => 0);
    setCatalog(ids);

    const frames = vi.spyOn(window, "requestAnimationFrame");
    renderBackground("/");
    // Already on <html> straight after the render, with no animation frame having run.
    expect(document.documentElement.style.getPropertyValue("--wp-vis")).not.toBe("");
    expect(document.documentElement.dataset.wallpaper).toBe("on");
    expect(frames).not.toHaveBeenCalled();
  });

  it("empty view uses emptyVisibility", () => {
    const ids = ["wp-001", "wp-002", "wp-003"];
    getBackgroundStore().ensureRolled(ids, () => 0);
    setCatalog(ids);

    // Only a new-agent draft screen is an "empty" view.
    const empty = renderBackground("/draft/new");
    expect(empty.result.current.view).toBe("empty");
    expect(document.documentElement.style.getPropertyValue("--wp-vis")).toBe("0.9");
    empty.unmount();

    const session = renderBackground("/worktree/w1/s1");
    expect(session.result.current.view).toBe("session");
    expect(document.documentElement.style.getPropertyValue("--wp-vis")).toBe("0.2");
  });

  it("exposes the gradient the window must draw", () => {
    const ids = ["wp-001", "wp-002", "wp-003"];
    const store = getBackgroundStore();
    store.ensureRolled(ids, () => 0);
    setCatalog(ids);

    const { result } = renderBackground("/");
    expect(result.current.gradient).toBe("fade_to_theme");

    act(() => store.patch({ gradient: "side_fade" }));
    expect(result.current.gradient).toBe("side_fade");
  });

  it("applies a kind override without changing the route-derived view", () => {
    const ids = ["wp-001", "wp-002", "wp-003"];
    getBackgroundStore().ensureRolled(ids, () => 0);
    setCatalog(ids);

    const { result } = renderBackground("/worktree/w1/s1", { t: "app" });

    expect(result.current.resolved).toEqual({ t: "image", id: "wp-001" });
    expect(result.current.view).toBe("session");
  });

  it("reduce transparency is solid on the very first render", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(prefers-reduced-transparency: reduce)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );

    const history: Array<{ t: string }> = [];
    renderHook(
      () => {
        const bg = useBackground();
        history.push(bg.resolved);
        return bg;
      },
      { wrapper: wrapper("/") },
    );

    expect(history[0]).toEqual({ t: "solid" });
  });
});
