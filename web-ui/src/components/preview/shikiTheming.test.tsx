import { render, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodeView } from "./CodeView";
import { DiffView } from "./DiffView";
import {
  getShikiHighlighter,
  setActiveTheme,
  __resetShikiHighlighterForTests,
} from "./shikiHighlighter";
import { useThemeStore } from "@/hooks/useThemeStore";

// A sample that yields several distinct Shiki token colors (keyword, string,
// plain identifiers, punctuation) so the per-theme palettes can be compared.
const SAMPLE_CODE = `const greeting: string = "hello world";\nfunction greet(name: string) {\n  return greeting + name;\n}\n`;

function shikiTokenColors(container: HTMLElement): string[] {
  const spans = container.querySelectorAll('span[style*="color"]');
  return Array.from(spans)
    .map((s) => (s as HTMLElement).style.color)
    .filter(Boolean);
}

describe("Phase 4 — Shiki highlighting follows the active theme", () => {
  // The 3 required flavors: one Vibestation, one other dark, one light.
  const themes = [
    { id: "vibestation-dark", label: "Vibestation Dark" },
    { id: "nord", label: "Nord (other dark)" },
    { id: "github-light", label: "GitHub Light (light)" },
  ];

  beforeEach(() => {
    __resetShikiHighlighterForTests();
  });

  async function renderCodeViewForTheme(id: string): Promise<string[]> {
    useThemeStore.getState().setThemeId(id);
    const { container, unmount } = render(<CodeView code={SAMPLE_CODE} language="typescript" />);
    await waitFor(
      () => {
        expect(
          container.querySelector('.workspace-code-content--shiki span[style*="color"]'),
        ).toBeTruthy();
      },
      { timeout: 15000 },
    );
    const colors = shikiTokenColors(container);
    unmount();
    return colors;
  }

  async function renderDiffViewForTheme(id: string): Promise<string[]> {
    useThemeStore.getState().setThemeId(id);
    const { container, unmount } = render(
      <DiffView oldText={SAMPLE_CODE} newText={SAMPLE_CODE} filePath="auth.ts" />,
    );
    await waitFor(
      () => {
        expect(
          container.querySelector('.diff-line-text--shiki span[style*="color"]'),
        ).toBeTruthy();
      },
      { timeout: 15000 },
    );
    const colors = shikiTokenColors(container);
    unmount();
    return colors;
  }

  it("4.T1 — CodeView renders different inline token colors per theme", async () => {
    const palettes: string[][] = [];
    for (const t of themes) {
      palettes.push(await renderCodeViewForTheme(t.id));
    }
    // Every theme must produce at least one colored token...
    for (const p of palettes) expect(p.length).toBeGreaterThan(0);
    // ...and the three palettes must be pairwise distinct (not just a class swap).
    expect(new Set(palettes[0])).not.toEqual(new Set(palettes[1]));
    expect(new Set(palettes[1])).not.toEqual(new Set(palettes[2]));
    expect(new Set(palettes[0])).not.toEqual(new Set(palettes[2]));
  }, 30000);

  it("4.T1 — DiffView renders different inline token colors per theme", async () => {
    const palettes: string[][] = [];
    for (const t of themes) {
      palettes.push(await renderDiffViewForTheme(t.id));
    }
    for (const p of palettes) expect(p.length).toBeGreaterThan(0);
    expect(new Set(palettes[0])).not.toEqual(new Set(palettes[1]));
    expect(new Set(palettes[1])).not.toEqual(new Set(palettes[2]));
    expect(new Set(palettes[0])).not.toEqual(new Set(palettes[2]));
  }, 30000);

  it("4.T2 — re-switching to an already-loaded theme does not call loadTheme again", async () => {
    const h = await getShikiHighlighter();
    const spy = vi.spyOn(h, "loadTheme");

    await setActiveTheme("one-dark-pro");
    await setActiveTheme("nord");
    await setActiveTheme("one-dark-pro"); // back to a previously-loaded id

    // one-dark-pro + nord = 2 loads; the second "one-dark-pro" must hit the cache.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, "one-dark-pro");
    expect(spy).toHaveBeenNthCalledWith(2, "nord");
  });
});
