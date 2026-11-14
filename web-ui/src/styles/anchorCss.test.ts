import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCascade } from "@/test/cssCascade";
import {
  FILES_LEFT_PANE_MIN_WIDTH,
  FILES_LEFT_PANE_MIN_WIDTH_DESKTOP,
  PANE_ROW_H,
  TOOLS_RAIL_COL_W,
  TOOLS_TOGGLE_SIZE,
} from "@/lib/layoutSizes";

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");
const css = loadCascade([
  read("tokens.css"),
  read("workspace.css"),
  read("../components/layout/ToolsRailColumn.css"),
  read("../components/artifacts/artifacts.css"),
]);

const RAIL_COL = TOOLS_RAIL_COL_W;
/** Room the open list's header keeps for its own items (mode label + a control) beside the chip's reserve. */
const LIST_HEADER_ITEMS_MIN = 64;
const CHIP_W = 105; // 1 (border) + 8 + 3 * 28 + 2 * 4 + 4

// The top-right actions chip: Search / "..." / tools toggle are ONE box, anchored to #workspace-layout, whose width
// comes from tokens. jsdom has no layout engine, so these assert the RESOLVED values (var()/calc()/@media evaluated)
// the geometry is built from; the rendered positions and frames are measured in a real browser under
// `.vibekit/reports/ui-round3-shots/after/`.
describe("actions chip", () => {
  it("the shared sizes resolve to the JS twins in lib/layoutSizes", () => {
    expect(css.varPx(".app-shell", "--pane-row-h")).toBe(PANE_ROW_H);
    expect(css.varPx(".app-shell", "--tools-toggle-size")).toBe(TOOLS_TOGGLE_SIZE);
    expect(css.varPx(".app-shell", "--tools-rail-col-w")).toBe(TOOLS_RAIL_COL_W);
  });

  it("the toggle is centred in the rail column: inset = (column - toggle) / 2, the chip's right padding", () => {
    const inset = (RAIL_COL - TOOLS_TOGGLE_SIZE) / 2;
    expect(css.varPx(".app-shell", "--tools-rail-col-w")).toBe(RAIL_COL);
    expect(css.varPx(".app-shell", "--tools-toggle-inset")).toBe(inset);
    expect(css.px(".top-bar-floating-actions", "padding-right")).toBe(inset);
    expect(css.px(".tools-rail", "width")).toBe(RAIL_COL);
  });

  it("restores main's chrome: elevated background, left + bottom border, 6px bottom-left radius, a shadow, row height", () => {
    const d = css.decls(".top-bar-floating-actions");
    expect(d.background).toBe("var(--bg-elevated)");
    expect(d["border-left"]).toBe("var(--border-width) solid var(--border-default)");
    expect(d["border-bottom"]).toBe("var(--border-width) solid var(--border-default)");
    expect(d["border-bottom-left-radius"]).toBe("var(--radius-md)");
    expect(d["box-shadow"]).toBeTruthy();
    expect(css.px(".top-bar-floating-actions", "height")).toBe(PANE_ROW_H);
    expect(css.px(".top-bar-floating-actions", "padding-left")).toBe(8);
    expect(css.px(".top-bar-floating-actions", "border-bottom-left-radius")).toBe(6);
  });

  it("the chip's own box has no transition, animation, opacity or visibility rule (nothing can flicker)", () => {
    for (const sel of [".top-actions-anchor", ".top-bar-floating-actions"]) {
      const d = css.decls(sel);
      for (const prop of ["transition", "animation", "opacity", "visibility"]) {
        expect(d[prop], `${sel} ${prop}`).toBeUndefined();
      }
    }
  });

  it(".top-actions-anchor is absolute at top 0 / right 0 above the panes; hidden only by a fullscreen mode", () => {
    const d = css.decls(".top-actions-anchor");
    expect(d.position).toBe("absolute");
    expect(css.px(".top-actions-anchor", "top")).toBe(0);
    expect(css.px(".top-actions-anchor", "right")).toBe(0);
    expect(Number(d["z-index"])).toBeGreaterThanOrEqual(50);
    expect(css.decls("#workspace-layout[data-pane-fullscreen] > .top-actions-anchor").visibility).toBe("hidden");
  });

  it("--top-actions-w resolves to 105 and the buttons are the shared toggle size", () => {
    expect(css.varPx(".app-shell", "--top-actions-w")).toBe(CHIP_W);
    for (const sel of [".top-bar-floating-actions .top-bar__pane-btn", ".top-bar-floating-actions .icon-btn"]) {
      expect(css.px(sel, "width"), sel).toBe(TOOLS_TOGGLE_SIZE);
      expect(css.px(sel, "height"), sel).toBe(TOOLS_TOGGLE_SIZE);
    }
    // The chip box itself (border + padding + 3 buttons + 2 gaps + padding) is exactly --top-actions-w wide.
    const chipBox =
      (css.varPx(".app-shell", "--border-width") ?? 0) +
      (css.px(".top-bar-floating-actions", "padding-left") ?? 0) +
      3 * TOOLS_TOGGLE_SIZE +
      2 * (css.varPx(".app-shell", "--space-1") ?? 0) +
      (css.px(".top-bar-floating-actions", "padding-right") ?? 0);
    expect(chipBox).toBe(css.varPx(".app-shell", "--top-actions-w"));
  });

  it("the active reserve is 105 wide, 69 under the rail (`[data-rail]`), and the offline pill adds --conn-pill-max + 4", () => {
    expect(css.px(".actions-host__reserve[data-active]", "width")).toBe(CHIP_W);
    const under = css.varPx("#workspace-layout[data-rail]", "--top-actions-under");
    expect(under).toBe(RAIL_COL);
    expect(CHIP_W - (under ?? 0)).toBe(69);
    const pill = css.varPx("#workspace-layout:has(> .top-actions-anchor .conn-pill)", "--top-actions-pill");
    expect(pill).toBe((css.varPx(".app-shell", "--conn-pill-max") ?? 0) + 4);
    expect(css.decls(".actions-host__reserve").display).toBe("none");
  });

  it("the offline pill is capped (dot + Retry inside the chip) so chip + reserve fit the narrowest list", () => {
    expect(css.px(".top-bar-floating-actions .conn-pill", "max-width")).toBe(72);
    const pill = (css.varPx(".app-shell", "--conn-pill-max") ?? 0) + 4;
    // Reserve in a list header (outside the rail column) must never exceed the minimum list width, or the chip
    // would cover the Files bar's layout/fullscreen buttons.
    expect(CHIP_W - RAIL_COL + pill + 4).toBeLessThanOrEqual(FILES_LEFT_PANE_MIN_WIDTH);
    // The DESKTOP floor (224) must also leave the header its own items: a fourth chip button (CHIP_W + 28 + 4) fails
    // here until FILES_LEFT_PANE_MIN_WIDTH_DESKTOP is raised.
    expect(CHIP_W - RAIL_COL + pill + 4 + LIST_HEADER_ITEMS_MIN).toBeLessThanOrEqual(FILES_LEFT_PANE_MIN_WIDTH_DESKTOP);
    expect(css.decls(".top-bar-floating-actions .conn-pill__label").position).toBe("absolute");
  });

  it("every top row is the shared row height (rail head, tool-panel bar, artifacts head, the chip)", () => {
    expect(css.px(".tools-rail__head", "height")).toBe(PANE_ROW_H);
    expect(css.px(".tool-panel__bar", "height")).toBe(PANE_ROW_H);
    expect(css.px(".tool-panel__bar", "min-height")).toBe(PANE_ROW_H);
    expect(css.px(".artifacts-head", "height")).toBe(PANE_ROW_H);
    expect(css.px(".rail-header", "height")).toBe(PANE_ROW_H);
    expect(css.px(".top-bar-floating-actions", "height")).toBe(PANE_ROW_H);
  });

  it(".actions-row: flush right on desktop (the reserve is the only inset), normal right gutter on phones", () => {
    expect(css.px(".actions-row", "padding-left")).toBe(8);
    expect(css.px(".actions-row", "padding-right")).toBe(0);
    expect(css.px(".actions-row", "padding-right", { phone: true })).toBe(8);
    expect(css.px(".actions-row", "padding-top")).toBe(0);
    // A row with its own gutter overrides the variable on itself (artifacts head: 10px), on both sizes.
    expect(css.varPx(".artifacts-head", "--actions-row-pad")).toBe(10);
  });

  it("no per-row selector sets the reserve-row right padding (one class owns it)", () => {
    for (const sel of [".tool-panel__bar", ".references-panel__header", ".outline-panel__header", ".search-panel__bar", ".file-tree-sidebar-header", ".artifacts-head", ".rail-header"]) {
      for (const phone of [false, true]) {
        expect(css.decls(sel, { phone })["padding-right"], `${sel} phone=${phone}`).toBeUndefined();
        expect(css.decls(sel, { phone })["padding"], `${sel} phone=${phone}`).toBeUndefined();
      }
    }
  });

  it("no selector mentions the removed transition hold / corner machinery", () => {
    const gone = ["data-tools-transition", "data-list-transition", "tools-corner", "actions-host__corner", "actions-host__global", "top-bar-floating-actions-container"];
    for (const s of css.selectors()) for (const g of gone) expect(s, s).not.toContain(g);
    expect(css.varPx(".app-shell", "--actions-host-gap")).toBeNull();
  });
});

describe("phone list header and tab close", () => {
  it("phone list-header pane controls are 36px wide; the tab bar keeps 44px", () => {
    expect(css.px(".files-left-pane-overlay .actions-host .tab.tab--icon.tool-bar-btn", "width", { phone: true })).toBe(36);
    expect(css.px(".tool-panel .tab.tab--icon.tool-bar-btn", "width", { phone: true })).toBe(44);
  });

  it("a file tab's close has a 28px touch target on phones only", () => {
    expect(css.px(".files-topbar__tab-close", "min-width", { phone: true })).toBe(28);
    expect(css.px(".files-topbar__tab-close", "min-height", { phone: true })).toBe(28);
    expect(css.px(".files-topbar__tab-close", "min-width")).toBeNull();
  });

  it("the artifact phone preview bar is gone", () => {
    expect(css.selectors().filter((s) => s.includes("artifact-mtop"))).toEqual([]);
  });
});

describe("anchor fix: removed dead selectors stay removed", () => {
  it.each([
    ".files-left-pane__layout-toggle",
    ".files-left-pane__overlay-chrome",
    ".files-topbar__controls",
    ".files-topbar__zoom-label",
    ".tool-panel__files-tab-wrap",
    ".tool-panel__tabs-scroll",
    ".tool-panel__tabs-actions",
    ".top-bar__pane-toggles",
  ])("%s has no rule", (cls) => {
    expect(css.selectors().filter((s) => s.includes(cls))).toEqual([]);
  });
});
