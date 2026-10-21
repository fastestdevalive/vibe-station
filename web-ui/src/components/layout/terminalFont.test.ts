import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { refreshWhenFontReady, TERM_FONT_FAMILY } from "./terminalFont";

/** Mirrors xterm's OptionsService: only a CHANGED value fires a change event. */
function fakeTerm() {
  const changes: string[] = [];
  let ff = TERM_FONT_FAMILY;
  const options = {
    get fontFamily() {
      return ff;
    },
    set fontFamily(v: string) {
      if (v !== ff) {
        ff = v;
        changes.push(v);
      }
    },
  };
  return { options, changes, clearTextureAtlas: vi.fn() };
}

function stubFonts(load: unknown) {
  Object.defineProperty(document, "fonts", { value: load ? { load } : undefined, configurable: true });
}

afterEach(() => {
  Object.defineProperty(document, "fonts", { value: undefined, configurable: true });
});

describe("refreshWhenFontReady (2.T4)", () => {
  it("re-applies the family, clears the atlas and refits once the font loads", async () => {
    const load = vi.fn().mockResolvedValue([]);
    stubFonts(load);
    const term = fakeTerm();
    const fit = vi.fn();
    refreshWhenFontReady(term as unknown as Terminal, fit, () => false);
    await vi.waitFor(() => expect(fit).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledWith('13px "Geist Mono"');
    expect(term.options.fontFamily).toBe(TERM_FONT_FAMILY);
    expect(term.changes.length).toBeGreaterThanOrEqual(1);
    expect(term.changes[term.changes.length - 1]).toBe(TERM_FONT_FAMILY);
    expect(term.clearTextureAtlas).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the terminal was disposed before the font loaded", async () => {
    const load = vi.fn().mockResolvedValue([]);
    stubFonts(load);
    const term = fakeTerm();
    const fit = vi.fn();
    refreshWhenFontReady(term as unknown as Terminal, fit, () => true);
    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    await Promise.resolve();
    expect(fit).not.toHaveBeenCalled();
    expect(term.clearTextureAtlas).not.toHaveBeenCalled();
  });

  it("is a no-op without document.fonts", () => {
    stubFonts(undefined);
    const fit = vi.fn();
    expect(() => refreshWhenFontReady(fakeTerm() as unknown as Terminal, fit, () => false)).not.toThrow();
    expect(fit).not.toHaveBeenCalled();
  });
});
