import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WallpaperEntry } from "@/api/types";
import { CreditLine } from "./CreditLine";

const { openExternalMock } = vi.hoisted(() => ({ openExternalMock: vi.fn() }));
vi.mock("@/lib/openExternal", () => ({ openExternal: openExternalMock }));

function entry(over: Partial<WallpaperEntry> = {}): WallpaperEntry {
  return {
    id: "wp-010",
    name: "Fog Mountain",
    category: "abstract",
    mode: "any",
    url: "https://images.rawpixel.com/a.jpg",
    thumbnailUrl: "https://images.rawpixel.com/a.jpg",
    width: 683,
    height: 1024,
    license: "CC0",
    author: null,
    sourcePage: null,
    ...over,
  };
}

function creditText(container: HTMLElement): string {
  return container.querySelector(".wp-credit")?.textContent ?? "";
}

describe("CreditLine", () => {
  it("author", () => {
    const { container } = render(
      <CreditLine
        entry={entry({ author: "Free Nature Stock", sourcePage: "https://stocksnap.io/photo/x" })}
      />,
    );
    expect(creditText(container)).toBe("Fog Mountain · Free Nature Stock · CC0");
  });

  it("via rawpixel", () => {
    const { container } = render(
      <CreditLine
        entry={entry({ sourcePage: "https://www.rawpixel.com/image/6078799/railroads-fog" })}
      />,
    );
    expect(creditText(container)).toBe("Fog Mountain · via rawpixel · CC0");
  });

  it("keeps the entry's license", () => {
    const { container } = render(<CreditLine entry={entry({ author: "Ian Livesey", license: "CC BY 4.0" })} />);
    expect(creditText(container)).toBe("Fog Mountain · Ian Livesey · CC BY 4.0");
  });

  it("never empty without an author or a rawpixel source", () => {
    const { container } = render(
      <CreditLine entry={entry({ sourcePage: "https://stocksnap.io/photo/x" })} />,
    );
    expect(creditText(container)).toBe("Fog Mountain · CC0");
  });

  it("link opens sourcePage", () => {
    openExternalMock.mockClear();
    render(
      <CreditLine
        entry={entry({ author: "Free Nature Stock", sourcePage: "https://stocksnap.io/photo/x" })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Free Nature Stock" }));

    expect(openExternalMock).toHaveBeenCalledWith("https://stocksnap.io/photo/x");
  });
});
