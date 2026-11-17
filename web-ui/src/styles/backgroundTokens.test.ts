import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCascade } from "@/test/cssCascade";

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");

const tokensText = read("tokens.css");
const wallpaperText = read("wallpaper.css");
const workspaceText = read("workspace.css");
const chatText = read("chat.css");
const globalText = read("global.css");
const mainText = readFileSync(resolve(__dirname, "../main.tsx"), "utf8");
const settingsText = read("../components/settings/settings.css");
const backgroundSettingText = read("../components/settings/backgroundSetting.css");

const tokens = loadCascade([tokensText]);
const wallpaper = loadCascade([wallpaperText]);
const layout = loadCascade([workspaceText, globalText]);
const settings = loadCascade([tokensText, settingsText]);
const bgSetting = loadCascade([tokensText, backgroundSettingText]);

const WALLPAPER_ON = ':root[data-wallpaper="on"]';

// The window background is drawn by a `z-index: -1` fixed layer; every alpha/blur token defaults to
// "no wallpaper" so the app is pixel-identical until the root attribute is set (Decision 6).
describe("wallpaper tokens", () => {
  it("alpha tokens default to 100% in :root", () => {
    const root = tokens.decls(":root");
    expect(root["--wp-chrome-alpha"]).toBe("100%");
    expect(root["--wp-vis"]).toBe("1");
    expect(root["--wp-card-alpha"]).toBeUndefined();
  });

  it("--wp-sidebar-bg and --wp-main-bg are not defined in tokens.css", () => {
    // Layout's inline style reads them with today's token as fallback; defining them in :root would
    // override that fallback even when no wallpaper is drawn.
    expect(tokensText).not.toMatch(/--wp-sidebar-bg\s*:/);
    expect(tokensText).not.toMatch(/--wp-main-bg\s*:/);
    const root = tokens.decls(":root");
    expect(root["--wp-sidebar-bg"]).toBeUndefined();
    expect(root["--wp-main-bg"]).toBeUndefined();
  });

  it("wallpaper-on supplies the per-surface tokens only", () => {
    const on = wallpaper.decls(WALLPAPER_ON);
    expect(on["--wp-chrome-alpha"]).toBe("72%");
    expect(on["--wp-sidebar-bg"]).toContain("color-mix");
    expect(on["--wp-main-bg"]).toBe("transparent");
    expect(on["--wp-settings-nav-bg"]).toContain("color-mix");
    expect(on["--wp-settings-nav-bg"]).toContain("--wp-chrome-alpha");
    // The look constants have one owner (`:root` in wallpaper.css), so the
    // Picker's mini window can draw them while Settings is in Solid.
    for (const name of [
      "--wp-card-alpha",
      "--wp-composer-alpha",
      "--wp-blur-chrome",
      "--wp-blur-composer",
      "--wp-text-halo",
    ]) {
      expect(on[name], name).toBeUndefined();
    }
  });

  it("card/composer alpha and blur are constants on wallpaper.css :root", () => {
    const root = wallpaper.decls(":root");
    expect(root["--wp-card-alpha"]).toBe("78%");
    expect(root["--wp-composer-alpha"]).toBe("58%");
    expect(root["--wp-blur-chrome"]).toBe("12px");
    expect(root["--wp-blur-composer"]).toBe("14px");
  });

  it("the mini window's traffic-light colours are theme-independent tokens", () => {
    const root = tokens.decls(":root");
    expect(root["--window-light-close"]).toBe("#ff5f57");
    expect(root["--window-light-minimize"]).toBe("#febc2e");
    expect(root["--window-light-zoom"]).toBe("#28c840");
  });

  it("--wp-settings-nav-bg is not defined in tokens.css", () => {
    // SettingsPanel's inline style reads it with today's token as fallback (the
    // same pattern as `--wp-sidebar-bg`); defining it in :root would beat that
    // fallback while no wallpaper is drawn.
    expect(tokensText).not.toMatch(/--wp-settings-nav-bg\s*:/);
  });

  it("--wp-text-halo is a constant in wallpaper.css with a soft and a tight shadow", () => {
    // Text on no surface only needs a halo while an image is drawn; in Solid it
    // must stay byte-identical to today (no consumer rule reads it then). The
    // design pairs the soft 10px halo with a tight 2px one so small text keeps
    // crisp glyph edges on a bright image; the preview draws it in Settings too.
    expect(tokensText).not.toMatch(/--wp-text-halo\s*:/);
    const root = wallpaper.decls(":root");
    expect(root["--wp-text-halo"]).toContain("0 0 2px");
    expect(root["--wp-text-halo"]).toContain("0 1px 10px");
    expect(root["--wp-text-halo"]).toContain("color-mix");
    expect(root["--wp-text-halo"]).toContain("--bg-primary");
  });
});

describe("visibility transition", () => {
  const windowCss = read("../components/background/windowBackground.css");

  it("the window layer, not :root, transitions a registered scrim-visibility number", () => {
    expect(windowCss).toMatch(/@property --wp-scrim-vis \{[^}]*syntax: "<number>"/);
    expect(windowCss).toMatch(/\.window-bg \{[^}]*transition: --wp-scrim-vis 350ms/);
    // A :root transition would restyle the whole document and animate a wallpaper's first appearance.
    expect(windowCss).not.toMatch(/:root[^{]*\{[^}]*transition/);
  });

  it("the real window's scrim reads the animated value; the preview keeps reading --wp-vis", () => {
    expect(windowCss).toMatch(/\.window-bg__scrim \{[^}]*--scrim-vis: var\(--wp-vis, 1\)/);
    expect(windowCss).toMatch(/\.window-bg \.window-bg__scrim \{\s*--scrim-vis: var\(--wp-scrim-vis\)/);
  });

  it("reduced motion switches the transition off", () => {
    expect(windowCss).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.window-bg \{\s*transition: none/);
  });
});

describe("wallpaper surfaces", () => {
  /** Declarations of one wallpaper-on rule (exact compound selector). */
  const on = (selector: string) => wallpaper.decls(`${WALLPAPER_ON} ${selector}`);

  it("draft composer and its box let the draft wallpaper through", () => {
    expect(on(".draft-composer").background).toBe("transparent");
    const box = on(".draft-composer__box");
    expect(box.background).toContain("color-mix");
    expect(box.background).toContain("--wp-composer-alpha");
    expect(box["backdrop-filter"]).toContain("--wp-blur-composer");
  });

  it("the blurred box keeps its popovers above the quote and hint row", () => {
    // backdrop-filter makes `.draft-composer__box` a stacking context; without a
    // z-index its popovers paint under the later sibling quote line.
    expect(on(".draft-composer__box")["z-index"]).toBe("1");
  });

  it("tools pane frame and empty viewer are transparent", () => {
    expect(on(".tool-panel").background).toBe("transparent");
    expect(on(".pane.pane-stack:has(> .empty-state)").background).toBe("transparent");
  });

  it("docked list is ONE chrome-alpha, blurred overlay over transparent layers", () => {
    const overlay = on(".files-left-pane-overlay");
    expect(overlay.background).toContain("--wp-chrome-alpha");
    expect(overlay["backdrop-filter"]).toContain("--wp-blur-chrome");
    expect(overlay["-webkit-backdrop-filter"]).toContain("--wp-blur-chrome");
    for (const sel of [
      ".files-left-pane",
      ".files-left-pane__body",
      ".files-left-pane .pane",
      ".vcs-sidebar",
    ]) {
      expect(on(sel).background, sel).toBe("transparent");
    }
    for (const sel of [".files-topbar", ".files-left-rail", ".tools-rail"]) {
      expect(on(sel).background, sel).toContain("--wp-chrome-alpha");
    }
    for (const sel of [".files-topbar", ".tools-rail"]) {
      expect(on(sel)["backdrop-filter"], sel).toContain("--wp-blur-chrome");
    }
    // `.pane-fill-host` is rendered by no component (dead selector).
    for (const sel of wallpaper.selectors()) {
      expect(sel, sel).not.toContain(".pane-fill-host");
    }
  });

  it("phone tools tile rail is ONE chrome-alpha, blurred surface", () => {
    const rail = on(".tool-panel__tile-rail");
    expect(rail.background).toContain("color-mix");
    expect(rail.background).toContain("--wp-chrome-alpha");
    expect(rail["backdrop-filter"]).toContain("--wp-blur-chrome");
    expect(rail["-webkit-backdrop-filter"]).toContain("--wp-blur-chrome");
    // The rail's inner `.files-left-rail` must not stack a second translucent layer.
    expect(on(".tool-panel__tile-rail .files-left-rail").background).toBe("transparent");
  });

  it("loose text on the wallpaper gets the halo, caption/empty state go secondary", () => {
    for (const sel of [
      ".draft-composer__caption",
      ".draft-composer__hint",
      ".draft-quote-line",
      ".empty-state",
      ".dashboard-header",
      ".dashboard-section__label",
      ".dashboard-kanban__col-title",
    ]) {
      expect(on(sel)["text-shadow"], sel).toBe("var(--wp-text-halo)");
    }
    for (const sel of [".draft-composer__caption", ".draft-composer__hint", ".empty-state"]) {
      expect(on(sel).color, sel).toBe("var(--fg-secondary)");
    }
    expect(on(".draft-composer__logo").filter).toContain("drop-shadow");
  });

  it("code/diff/terminal views stay opaque", () => {
    // The generic pane rule still paints --bg-primary, so an open file (and the VCS
    // commit list) stays opaque even though the tools frame is transparent.
    expect(layout.decls(".pane").background).toBe("var(--bg-primary)");
    expect(layout.decls(".vcs-panel").background).toBe("var(--bg-primary)");
    for (const sel of wallpaper.selectors()) {
      expect(sel, sel).not.toMatch(/\.(terminal-|code-view|diff-|preview-body)/);
    }
  });

  it("dashboard cards are card-alpha, hover stays visible", () => {
    for (const sel of [".acard", ".dashboard-card"]) {
      expect(on(sel).background, sel).toContain("--wp-card-alpha");
    }
    expect(on(".acard:hover").background).toContain("--wp-card-alpha");
    expect(on(".dashboard-card--project:hover").background).toContain("--wp-card-alpha");
  });

  it("sidebar takes the chrome blur", () => {
    const sidebar = on(".pane-left-inner");
    expect(sidebar["backdrop-filter"]).toContain("--wp-blur-chrome");
    expect(sidebar["-webkit-backdrop-filter"]).toContain("--wp-blur-chrome");
  });

  it("settings nav and content are chrome/card toned and blurred", () => {
    const nav = on(".settings-nav");
    expect(nav["backdrop-filter"]).toContain("--wp-blur-chrome");
    expect(nav["-webkit-backdrop-filter"]).toContain("--wp-blur-chrome");
    const content = on(".settings-content");
    expect(content.background).toContain("color-mix");
    expect(content.background).toContain("--wp-card-alpha");
    expect(content["backdrop-filter"]).toContain("--wp-blur-chrome");
  });

  it("status-bar blur lives on ::before, never on the bar itself", () => {
    // A backdrop-filter on the bar would make it the containing block for the phone
    // limits popup's `position: fixed` backdrop, trapping it inside the 24px bar.
    const bar = on(".global-status-bar");
    expect(bar["backdrop-filter"]).toBeUndefined();
    expect(bar["-webkit-backdrop-filter"]).toBeUndefined();
    expect(bar.background).toContain("--wp-chrome-alpha");
    const pseudo = on(".global-status-bar::before");
    expect(pseudo.position).toBe("absolute");
    expect(pseudo["backdrop-filter"]).toContain("--wp-blur-chrome");
    expect(pseudo["pointer-events"]).toBe("none");
  });
});

describe("wallpaper.css scoping", () => {
  it('every selector is the :root constants block or starts with :root[data-wallpaper="on"]', () => {
    const selectors = wallpaper.selectors();
    expect(selectors.length).toBeGreaterThan(0);
    for (const sel of selectors) {
      expect(sel === ":root" || sel.startsWith(WALLPAPER_ON), sel).toBe(true);
    }
  });

  it("workspace.css and chat.css contain no data-wallpaper rule", () => {
    expect(workspaceText).not.toContain("data-wallpaper");
    expect(chatText).not.toContain("data-wallpaper");
  });

  it("no bare hex in wallpaper.css", () => {
    expect(wallpaperText).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("main.tsx imports wallpaper.css after chat.css", () => {
    const chat = mainText.indexOf('"./styles/chat.css"');
    const wallpaperImport = mainText.indexOf('"./styles/wallpaper.css"');
    expect(chat).toBeGreaterThan(-1);
    expect(wallpaperImport).toBeGreaterThan(chat);
  });
});

describe("settings content column", () => {
  it("one token caps the desktop content column, and the column consumes it", () => {
    const root = tokens.decls(":root");
    expect(root["--settings-content-max-w"]).toBe("800px");
    expect(root["--settings-preview-max-h"]).toContain("clamp");

    expect(settings.px(".settings-content__inner", "max-width")).toBe(800);
    expect(settings.decls(".settings-content__inner")["margin-inline"]).toBe("auto");
  });

  it(".bg-setting caps the Background preview by height; onboarding stays full width", () => {
    // The cap is a width derived from the height token, so `aspect-ratio: 16/9`
    // keeps the preview's 16:9 crop (a max-height alone would not). The frame is
    // the sized container; the preview inside it is 100% of the frame.
    const frame = bgSetting.decls(".bg-setting .wp-preview-frame");
    expect(frame["max-width"]).toContain("--settings-preview-max-h");
    expect(frame["margin-inline"]).toBe("auto");

    // Onboarding renders Picker outside `.bg-setting`, so its preview keeps 100%.
    expect(loadCascade([read("../components/background/picker.css")]).decls(".wp-preview-frame").width).toBe("100%");
  });
});

describe("the background layer reaches the root stacking context", () => {
  // The layer is `position: fixed; z-index: -1`; any stacking context created by the shell wrappers
  // would paint it behind them (or hide it), so these three must stay neutral.
  it(".app-shell, .workspace-route and #root rules have no isolation, transform, filter, opacity<1 or z-index", () => {
    for (const sel of [".app-shell", ".workspace-route", "#root"]) {
      const d = layout.decls(sel);
      expect(d.isolation, sel).toBeUndefined();
      expect(d.transform, sel).toBeUndefined();
      expect(d.filter, sel).toBeUndefined();
      expect(d["backdrop-filter"], sel).toBeUndefined();
      expect(d["z-index"], sel).toBeUndefined();
      expect(Number(d.opacity ?? 1), sel).toBeGreaterThanOrEqual(1);
    }
  });
});
