import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "accounts.css"), "utf8");

/** Body of the brace-balanced block that starts at `header`. */
function block(source: string, header: string): string {
  const start = source.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced block: ${header}`);
}

// jsdom has no layout, so assert the declarations that keep phone targets at 44px.
describe("accounts phone sheet", () => {
  const phone = block(css, "@media (max-width: 640px)");

  it("makes footer buttons and the close button touch sized", () => {
    const rule = block(phone, ".accounts-dialog-card .dialog-card__footer button,");
    expect(rule).toMatch(/min-height:\s*var\(--h-touch\)/);
    expect(rule).toMatch(/min-width:\s*var\(--h-touch\)/);
  });

  it("makes radio rows and the API key link touch sized", () => {
    expect(block(phone, ".accounts-dialog__radio,")).toMatch(/min-height:\s*var\(--h-touch\)/);
    expect(block(phone, "\n\n  .accounts-dialog__link {")).toMatch(/display:\s*inline-flex/);
  });

  it("makes the picker footer add button touch sized", () => {
    const picker = block(css, "@media (max-width: 768px) {\n  .account-picker__chip");
    expect(picker).toContain(".account-picker__add");
  });
});

describe("account chip", () => {
  it("keeps the monogram a fixed round box with token colours only", () => {
    const rule = block(css, ".account-chip__mark {");
    expect(rule).toMatch(/flex:\s*none/);
    expect(rule).toMatch(/border-radius:\s*var\(--radius-full\)/);
    expect(rule).not.toContain("#");
  });
});

describe("account chip rows (R2F-10, R2F-06)", () => {
  it("draws the row monogram as a 24px avatar", () => {
    expect(block(css, ".account-chip--row .account-chip__mark {")).toMatch(/width:\s*var\(--account-band\)/);
    expect(block(css, "\n.account-chip--row {")).toMatch(/--account-band:\s*var\(--space-6\)/);
  });

  it("keeps the dashed-state mark's cue in the border, not in dimmer letters", () => {
    const rule = block(css, '.account-chip[data-state="signed_out"] .account-chip__mark,');
    expect(rule).toContain("border-style: dashed");
    expect(rule).not.toMatch(/(^|[\s;])color:/);
  });

  it("keeps the mark flat and token-only", () => {
    const rule = block(css, ".account-chip__mark {");
    expect(rule).toMatch(/flex:\s*none/);
    expect(rule).not.toContain("#");
  });

  it("wraps the chips under the name before cutting it", () => {
    expect(block(css, ".account-chip__line {")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("lets the picker and switch menu grow, and span the phone sheet", () => {
    expect(block(css, ".account-picker__popover,\n.account-menu {")).toMatch(/width:\s*max-content/);
    const phone = block(css, "@media (max-width: 768px) {\n  .account-picker__chip");
    expect(block(phone, ".account-picker__popover,\n  .account-menu {")).toMatch(/width:\s*auto/);
  });

  it("puts a phone row's buttons on a second line when it has a contextual button (R2F-04)", () => {
    const phone = block(css, "@media (max-width: 768px) {\n  .accounts-row {");
    expect(block(phone, ".accounts-row--action {")).toMatch(/flex-wrap:\s*wrap/);
    const actions = block(phone, ".accounts-row--action .accounts-row__actions {");
    expect(actions).toMatch(/flex-basis:\s*100%/);
    expect(actions).toMatch(/justify-content:\s*flex-end/);
  });

  it("positions the switch menu from the component, fixed, with no mount-site rules", () => {
    expect(block(css, ".account-menu {")).toMatch(/position:\s*fixed/);
    expect(css).not.toContain(".account-banner--compact .account-menu");
    expect(css).not.toContain(".account-banner__menu-anchor");
  });
});

describe("limits phone targets (R1F-14)", () => {
  it("gives popup rows and the Refresh button the touch height on phones", () => {
    const limitsCss = readFileSync(resolve(__dirname, "../../styles/limits.css"), "utf8");
    const phone = block(limitsCss, "@media (max-width: 768px)");
    const rule = block(phone, ".limits-popup__row,");
    expect(rule).toMatch(/min-height:\s*var\(--h-touch\)/);
    expect(phone).toContain(".limits-popup__footer .limit-chip");
  });
});

describe("round 2 polish CSS", () => {
  it("R2F-07: the break card wraps pills and ellipsises one long name inside", () => {
    const chat = readFileSync(resolve(__dirname, "../../styles/chat.css"), "utf8");
    const providers = block(chat, ".chat-session-break__providers {");
    expect(providers).toMatch(/flex-wrap:\s*wrap/);
    expect(providers).toMatch(/min-width:\s*0/);
    const pill = block(chat, ".chat-session-break__pill {");
    expect(pill).toMatch(/max-width:\s*100%/);
    expect(pill).toMatch(/min-width:\s*0/);
  });

  it("R2F-11: the footer chip hit area is touch height and the group title has a gap", () => {
    const limitsCss = readFileSync(resolve(__dirname, "../../styles/limits.css"), "utf8");
    const before = block(limitsCss, ".limits-bar > .limit-chip::before");
    expect(before).toMatch(/height:\s*var\(--h-touch\)/);
    expect(block(limitsCss, ".limits-popup__group-title {")).toMatch(/gap:/);
  });

  it("R2F-12: the name block is a flex column", () => {
    const rule = block(css, ".accounts-dialog__mode-block {");
    expect(rule).toMatch(/flex-direction:\s*column/);
    expect(rule).toMatch(/min-height/);
  });
});

describe("round 1 (multi-account-5) row alignment CSS", () => {
  it("R1F-01: row buttons share one height; the menu button is borderless with a focus ring", () => {
    expect(block(css, ".accounts-row__action,\n.accounts-row__menu-btn {")).toMatch(/height:\s*var\(--account-action-h\)/);
    const btn = block(css, ".accounts-row__menu-btn {\n  width");
    expect(btn).toMatch(/border:\s*0/);
    expect(btn).toMatch(/padding:\s*0/);
    expect(css).toContain(".accounts-row__menu-btn:focus-visible");
    expect(css).toContain(".accounts-row__menu-item:focus-visible");
    const phone = block(css, "@media (max-width: 768px) {\n  .accounts-row {");
    expect(phone).toMatch(/--account-action-h:\s*var\(--h-touch\)/);
  });

  it("R1F-03: the row chip is a first-line band", () => {
    const row = block(css, "\n.account-chip--row {");
    expect(row).toMatch(/align-items:\s*flex-start/);
    expect(row).toContain("--account-band");
    expect(block(css, ".account-chip--row .account-chip__name {")).toMatch(/line-height:\s*var\(--account-band\)/);
    expect(block(css, "\n.account-chip__state {")).not.toContain("--h-md");
    expect(block(css, "\n.account-chip__trailing {")).toMatch(/align-self:\s*flex-start/);
    expect(block(css, "\n.accounts-row__actions {")).toMatch(/margin-block:\s*calc\(/);
  });

  it("R1F-08: picker meter is grouped with the settings meter rule", () => {
    expect(css).toMatch(/\.accounts-row__meter,\s*\.account-picker__meter \{/);
  });

  it("R1F-09: menu items are 32px on desktop, touch on phones", () => {
    expect(block(css, "\n.accounts-row__menu-item {")).toMatch(/min-height:\s*var\(--h-lg\)/);
    expect(block(css, "@media (max-width: 768px) {\n  .accounts-row {")).toContain(".accounts-row__menu-item");
  });

  it("R1F-11: the banner sentence is one centred line", () => {
    const rule = block(css, ".account-banner__text {");
    expect(rule).toMatch(/display:\s*inline-flex/);
    expect(rule).toMatch(/align-items:\s*center/);
  });

  it("R1F-10: limits group titles give the chip name the title's type", () => {
    const limits = readFileSync(resolve(__dirname, "../../styles/limits.css"), "utf8");
    const start = limits.indexOf(".limits-popup__group-title .account-chip__name {");
    expect(start).toBeGreaterThanOrEqual(0);
    const rule = limits.slice(start, limits.indexOf("}", start));
    expect(rule).toMatch(/font-size:\s*inherit/);
    expect(rule).toMatch(/font-weight:\s*inherit/);
  });

  it("R1F-07: folder field input inherits the wrapper font", () => {
    expect(block(css, "\n.accounts-folder-field__input {")).toMatch(/font:\s*inherit/);
    expect(block(css, "\n.accounts-folder-field__ghost-wrap {")).toContain("var(--font-mono)");
  });
});

describe("accounts row menu and phone targets", () => {
  it("positions the row menu fixed (placed by script, no right anchor)", () => {
    const rule = block(css, ".accounts-row__menu {");
    expect(rule).toMatch(/position:\s*fixed/);
    expect(rule).not.toMatch(/right:\s*0/);
  });

  it("uses 16px folder-field text on phones, 12px otherwise", () => {
    const phone = block(css, "@media (max-width: 640px)");
    expect(block(phone, ".accounts-folder-field__ghost-wrap,")).toMatch(/font-size:\s*var\(--fs-input\)/);
    expect(block(css, "\n.accounts-folder-field__ghost-wrap {")).toMatch(/font-size:\s*var\(--font-size-sm\)/);
  });

  it("gives the pane account trigger a stacked 44px hit area", () => {
    const tablet = block(css, "@media (max-width: 768px) {\n  .account-picker__chip");
    expect(block(tablet, "  .session-account__btn {")).toMatch(/z-index:\s*1/);
    expect(block(tablet, ".session-account__btn::before {")).toMatch(/inset:\s*-12px 0/);
    expect(block(tablet, ".agent-pane-header .session-account__btn::before")).toMatch(/inset:\s*-4px 0 -20px/);
  });
});
