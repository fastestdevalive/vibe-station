import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BakedStatus } from "../bake/useBakedWallpaper";
import { textureById } from "../textureCatalog";
import { PictureLayer } from "../WallpaperPicture";
import { WallpaperEffect } from "./WallpaperEffect";

const hook = vi.hoisted(() => ({
  state: { url: null as string | null, status: "idle" as BakedStatus },
  /** Every argument set the component asked the bake hook for. */
  calls: [] as unknown[],
}));

vi.mock("../bake/useBakedWallpaper", () => ({
  useBakedWallpaper: (args: unknown) => {
    hook.calls.push(args);
    return hook.state;
  },
}));

const STATUSES: BakedStatus[] = ["idle", "baking", "ready", "failed"];

function renderEffect(textureId: string, overrides: { src?: string | null; onStatus?: (s: BakedStatus) => void } = {}) {
  return render(
    <WallpaperEffect
      id="wp-007"
      src={overrides.src === undefined ? "blob:source" : overrides.src}
      sha={null}
      texture={textureById(textureId)}
      intensity={0.8}
      onStatus={overrides.onStatus}
    />,
  );
}

beforeEach(() => {
  hook.state = { url: null, status: "idle" };
  hook.calls = [];
});

describe("WallpaperEffect", () => {
  it("none renders nothing", () => {
    const { container } = renderEffect("none");

    expect(container.firstChild).toBeNull();
  });

  it("haze and frost render css layers", () => {
    const haze = renderEffect("haze");
    expect(haze.container.querySelector(".wp-haze")).not.toBeNull();
    // The CSS layers scale themselves, so the wrapper stays fully opaque.
    expect((haze.container.querySelector(".wp-effect") as HTMLElement).style.opacity).toBe("");
    // The CSS layers take the wallpaper's focal point from the effect layer.
    expect((haze.container.querySelector(".wp-effect") as HTMLElement).style.getPropertyValue("--wp-focal")).toBe(
      "50% 34%",
    );
    haze.unmount();

    const frost = renderEffect("frost");
    expect(frost.container.querySelector(".wp-frost")).not.toBeNull();
  });

  it("css effects without a source render nothing", () => {
    const { container } = renderEffect("haze", { src: null });

    expect(container.firstChild).toBeNull();
  });

  it("baked failure leaves plain wallpaper", () => {
    hook.state = { url: null, status: "failed" };

    const { container } = renderEffect("dither");

    expect(container.querySelector(".wp-picture")).toBeNull();
    expect(container.querySelector(".wp-effect")).not.toBeNull();
  });

  it("baked ready renders the picture", () => {
    hook.state = { url: "blob:baked", status: "ready" };

    const { container } = renderEffect("dither");

    const img = container.querySelector(".wp-picture") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("blob:baked");
  });

  it("plain and baked pictures share one class and one focal position", () => {
    hook.state = { url: "blob:baked", status: "ready" };

    const { container } = render(
      <>
        <PictureLayer id="wp-003" src="blob:plain" />
        <WallpaperEffect
          id="wp-003"
          src="blob:plain"
          sha={null}
          texture={textureById("dither")}
          intensity={0.8}
        />
      </>,
    );

    const pictures = [...container.querySelectorAll<HTMLImageElement>(".wp-picture")];
    expect(pictures).toHaveLength(2);
    for (const img of pictures) expect(img.style.objectPosition).toBe("50% 82%");
  });

  it("a baked picture that was ready on mount does not animate; one that lands later does", () => {
    hook.state = { url: "blob:baked", status: "ready" };
    const mounted = renderEffect("dither");
    expect(
      (mounted.container.querySelector(".wp-picture") as HTMLElement).classList.contains("wp-picture--arriving"),
    ).toBe(false);
    mounted.unmount();

    hook.state = { url: null, status: "baking" };
    const later = renderEffect("dither");
    expect(later.container.querySelector(".wp-picture")).toBeNull();

    hook.state = { url: "blob:baked", status: "ready" };
    later.rerender(
      <WallpaperEffect
        id="wp-007"
        src="blob:source"
        sha={null}
        texture={textureById("dither")}
        intensity={0.8}
      />,
    );
    expect(
      (later.container.querySelector(".wp-picture") as HTMLElement).classList.contains("wp-picture--arriving"),
    ).toBe(true);
  });

  it("intensity is the wrapper's opacity, not a bake input", () => {
    hook.state = { url: "blob:baked", status: "ready" };

    const { container, rerender } = renderEffect("dither");
    const effect = () => container.querySelector(".wp-effect") as HTMLElement;
    expect(effect().style.opacity).toBe("0.8");

    rerender(
      <WallpaperEffect
        id="wp-007"
        src="blob:source"
        sha={null}
        texture={textureById("dither")}
        intensity={0.3}
      />,
    );

    expect(effect().style.opacity).toBe("0.3");
    // Both renders asked for the same bake: intensity is not part of it, so the
    // slider never triggers a re-bake.
    expect(hook.calls).toHaveLength(2);
    expect(hook.calls[1]).toEqual(hook.calls[0]);
    for (const args of hook.calls) expect(args).not.toHaveProperty("intensity");
  });

  it("onStatus reports baking then ready", () => {
    const seen: BakedStatus[] = [];
    hook.state = { url: null, status: "baking" };

    const { rerender } = renderEffect("dither", { onStatus: (s) => seen.push(s) });
    expect(seen).toEqual(["baking"]);

    hook.state = { url: "blob:baked", status: "ready" };
    rerender(
      <WallpaperEffect
        id="wp-007"
        src="blob:source"
        sha={null}
        texture={textureById("dither")}
        intensity={0.8}
        onStatus={(s) => seen.push(s)}
      />,
    );

    expect(seen).toEqual(["baking", "ready"]);
    expect(seen.every((s) => STATUSES.includes(s))).toBe(true);
  });
});
