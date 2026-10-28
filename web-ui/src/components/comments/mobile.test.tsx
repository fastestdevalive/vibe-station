import { act, fireEvent, render, screen } from "@testing-library/react";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { getLexicalEditor } from "@/components/chat/lexicalTestSeam";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { CommentBox } from "./CommentBox";
import { PinMeasurer } from "./pinMeasurer";
import { popoverPosition } from "./SelectionPopover";

function matchMedia(queries: (q: string) => boolean) {
  window.matchMedia = ((q: string) => ({
    matches: queries(q),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as never;
}

const api = createMockApi();
const mentions = { api, projectId: "p1", worktreeId: "wt-1", selfSessionId: null, kinds: ["file" as const] };
const rect = (top: number, bottom: number, left = 20) => ({ top, bottom, left, right: left + 100, width: 100, height: bottom - top, x: left, y: top, toJSON: () => {} }) as DOMRect;

beforeEach(() => localStorage.clear());
afterEach(() => matchMedia(() => false));

describe("comment box on mobile (7.T1, R90)", () => {
  it("is a bottom sheet at <=768px with no keyboard-shortcut hint on touch", () => {
    matchMedia(() => true);
    render(<CommentBox mode="new" label="L1 · +" quote="q" draftKey="k" mentions={mentions} onSave={vi.fn()} onCancel={vi.fn()} />);
    const sheet = screen.getByRole("dialog", { name: "Add comment" });
    expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(sheet.className).toContain("bottom-sheet");
    expect(sheet.querySelector('[data-comment-box="new"]')).not.toBeNull();
    expect(screen.queryByText(/to add · Esc to cancel/)).toBeNull();
    expect(screen.getByRole("button", { name: "Add comment" })).toBeInTheDocument();
  });

  it("typing keeps focus in the editor (no refocus of the sheet on the first keystroke)", async () => {
    matchMedia(() => true);
    render(<CommentBox mode="new" label="L1 · +" quote="q" draftKey="kf" mentions={mentions} onSave={vi.fn()} onCancel={vi.fn()} />);
    const editor = screen.getByLabelText("Comment");
    (editor as HTMLElement).focus();
    const ed = getLexicalEditor(editor)!;
    await act(async () => {
      ed.update(() => {
        const root = $getRoot();
        root.clear();
        const p = $createParagraphNode();
        p.append($createTextNode("Hello"));
        root.append(p);
      });
    });
    expect(editor.textContent).toBe("Hello");
    expect(document.activeElement?.closest(".comment-box")).not.toBeNull();
  });

  it("an edit sheet is labelled Edit comment", () => {
    matchMedia(() => true);
    render(
      <CommentBox
        mode="edit"
        label="L1 · +"
        quote="q"
        draftKey="k2"
        seedText="hello"
        comment={{ id: "c1", pin: 1 } as never}
        mentions={mentions}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Edit comment" })).toBeInTheDocument();
  });

  it("closing the sheet asks before discarding typed text, and keeps the stored draft", async () => {
    matchMedia(() => true);
    localStorage.setItem("k3", "typed");
    const onCancel = vi.fn();
    render(<CommentBox mode="new" label="L1" quote="q" draftKey="k3" mentions={mentions} onSave={vi.fn()} onCancel={onCancel} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("bottom-sheet-backdrop"));
    });
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "Discard this comment?" })).toBeInTheDocument();
    expect(localStorage.getItem("k3")).toBe("typed");
  });

  it("a floating box ignores outside taps on the sheet: only the backdrop's own rules apply (round 5)", () => {
    matchMedia(() => true);
    const onDismiss = vi.fn();
    render(<CommentBox mode="new" label="L1 · +" quote="q" draftKey="k5" mentions={mentions} onSave={vi.fn()} onCancel={vi.fn()} onDismiss={onDismiss} />);
    fireEvent.pointerDown(document.body, { button: 0, pointerId: 1, pointerType: "touch", clientX: 5, clientY: 5 });
    fireEvent.pointerUp(document.body, { button: 0, pointerId: 1, pointerType: "touch", clientX: 5, clientY: 5 });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Add comment" })).toBeInTheDocument();
  });

  it("stays inline on desktop", () => {
    matchMedia(() => false);
    render(<CommentBox mode="new" label="L1" quote="q" draftKey="k4" mentions={mentions} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(/to add · Esc to cancel/)).toBeInTheDocument();
  });
});

describe("selection popover on touch (R89)", () => {
  const bounds = rect(0, 800, 0);
  it("keeps clear of the native callout: under the drag handles when there is room", () => {
    const pos = popoverPosition(rect(300, 320), bounds, 390, 844, true);
    expect(pos.top).toBeGreaterThanOrEqual(320 + 40);
  });
  it("goes above the callout when the selection is at the bottom of the screen", () => {
    const pos = popoverPosition(rect(780, 800), bounds, 390, 844, true);
    expect(pos.top).toBeLessThan(780 - 40);
  });
  it("desktop placement is unchanged (just above the selection)", () => {
    expect(popoverPosition(rect(300, 320), bounds, 1200, 800).top).toBe(300 - 32 - 6);
  });
});

describe("comment styles (7.2, 7.3)", () => {
  const css = (f: string) => readFileSync(resolve(__dirname, f), "utf8");
  it("the gutter + stays laid out (focusable / reachable by a screen reader) and only goes invisible", () => {
    const rule = /\.comment-plus \{[^}]*\}/.exec(css("comments.css").replace(/\/\*[\s\S]*?\*\//g, ""))![0];
    expect(rule).not.toMatch(/display:\s*none/);
    expect(rule).toMatch(/opacity:\s*0/);
    expect(rule).toMatch(/pointer-events:\s*none/);
  });
  it("compact tray controls, picker rows and the When / action bar controls are 44px touch targets (R1F-06)", () => {
    const tray = css("tray.css");
    expect(tray).toMatch(/\.comment-tray__strip--compact \.comment-tray__count \{\s*min-height: 44px;/);
    expect(tray).toMatch(/\.comment-tray__strip--compact \.comment-btn:not\(\.comment-tray__send\),\s*\.comment-tray__strip--compact \.comment-icon-btn \{\s*min-height: 44px;\s*min-width: 44px;/);
    const phone = tray.slice(tray.indexOf("mobile: the picker is a BottomSheet"));
    expect(phone).toMatch(/\.comment-picker__row \{\s*min-height: 44px;/);
    expect(phone).toMatch(/\.comment-picker__seg-btn \{\s*min-height: 44px;/);
    expect(phone).toMatch(/\.comment-picker__datetime \{\s*min-height: 44px;/);
    expect(phone).toMatch(/\.comment-picker__bar \.comment-btn \{\s*min-height: 44px;/);
    expect(tray).not.toMatch(/comment-picker__clock/);
  });
  it("the picker's action bar is sticky and the expanded tray has a 44px touch handle (round 4)", () => {
    const tray = css("tray.css");
    expect(tray).toMatch(/\.comment-picker__bar \{\s*position: sticky;\s*bottom: 0;/);
    expect(tray).toMatch(/@media \(pointer: coarse\), \(max-width: 768px\) \{\s*\.comment-tray__handle \{\s*top: -12px;\s*height: 44px;/);
    expect(tray).toMatch(/\.comment-tray__handle \{[^}]*touch-action: none;/);
    expect(tray).toMatch(/\.comment-tray__handle \{[^}]*top: -5px;[^}]*height: 10px;/);
  });
  it("the expanded tray shrinks so its strip stays visible (R1F-03)", () => {
    const tray = css("tray.css");
    expect(tray).toMatch(/\.comment-tray \{\s*flex: 0 1 auto;\s*min-height: 0;\s*max-height: 100%;/);
    expect(tray).toMatch(/\.comment-tray__strip \{\s*flex: none;/);
  });
  it("phones drop the saved card's 108px left margin (R1F-02)", () => {
    expect(css("comments.css")).toMatch(/@media \(max-width: 768px\)[\s\S]*\.comment-rowstack \{\s*margin-left: 12px;/);
  });
  it("tray rows give the checkbox its own 44px column on phones (R1F-09)", () => {
    expect(css("tray.css")).toMatch(/@media \(max-width: 768px\) \{[^@]*\.comment-list__item \{\s*grid-template-columns: 44px minmax\(0, 1fr\);/);
  });
  it("the tray slide only runs when motion is allowed", () => {
    const tray = css("tray.css");
    expect(tray).toMatch(/@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.comment-tray \{\s*animation:/);
    // no animation declaration outside that block
    const outside = tray.replace(/@media \(prefers-reduced-motion: no-preference\)\s*\{[\s\S]*?\n\}\n/, "");
    expect(outside).not.toMatch(/animation:/);
  });
  it("uses tokens only: no bare hex colours in the comment stylesheets", () => {
    for (const f of ["comments.css", "tray.css"]) expect(css(f), f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
  it("the Attach label hides in a narrow composer container", () => {
    expect(css("tray.css")).toMatch(/@container composer \(max-width: \d+px\)\s*\{\s*\.comment-attach__label \{\s*display: none;/);
  });
});

describe("comment pins on a coarse pointer (17)", () => {
  /** Two targets whose last characters sit 20px apart; the placements the measurer hands back. */
  function placements() {
    const host = document.createElement("div");
    const text = document.createElement("span");
    host.appendChild(text);
    document.body.appendChild(host);
    host.getBoundingClientRect = () => rect(0, 200);
    text.getBoundingClientRect = () => rect(0, 20);
    Object.defineProperty(host, "clientHeight", { value: 200, configurable: true });
    const ranges = [rect(10, 30), rect(30, 50)]; // (top, bottom): line centres 20 and 40
    let i = 0;
    const proto = Range.prototype as unknown as { getClientRects: () => DOMRectList };
    const original = proto.getClientRects;
    proto.getClientRects = () => [ranges[i++ % 2]!] as unknown as DOMRectList;
    text.textContent = "abcdef";
    const m = new PinMeasurer();
    const out: Array<{ top: number; ids: string[] }[]> = [];
    m.register({ host, textEl: () => text, targets: () => [{ id: "a", pin: 1, endCol: 3 }, { id: "b", pin: 2, endCol: 6 }], apply: (p) => out.push(p) });
    m.flush();
    proto.getClientRects = original;
    host.remove();
    return out[0]!;
  }

  it("merges pins closer than 24px (a 16px pin on a fine pointer merges only below 16px)", () => {
    matchMedia((q) => q === "(pointer: coarse)");
    expect(placements()).toHaveLength(1);
    matchMedia(() => false);
    expect(placements()).toHaveLength(2);
  });

  it("the stylesheet gives touch a 28px gutter, 20px pins and a 28px-wide hit area", () => {
    const css = readFileSync(resolve(__dirname, "comments.css"), "utf8");
    expect(css).toMatch(/@media \(pointer: coarse\) \{\s*\.preview-body\[data-comment-surface\] \{\s*--comment-gutter-w: 28px;\s*--comment-pin-size: 20px;/);
    expect(css).toMatch(/\.comment-pin-stack > \.comment-pin::before \{[^}]*inset: 0 -4px;/);
  });

  it("tray.css keeps the selected When segment readable on hover and the phone sheet bar flush", () => {
    const css = readFileSync(resolve(__dirname, "tray.css"), "utf8");
    expect(css).toMatch(/\.comment-picker__seg-btn--on:hover \{[^}]*background: var\(--fg-primary\);/);
    expect(css).toMatch(/\.bottom-sheet:has\(\.comment-picker__bar\) \{\s*padding-bottom: 0;/);
    expect(css).toMatch(/\.comment-picker__why \{\s*white-space: normal;\s*min-width: 0;/);
    expect(css).not.toMatch(/scroll-margin-bottom: 96px/);
    expect(css).toMatch(/\.comment-picker__bar \.comment-picker__warn \{\s*margin: 0 0 8px;/);
  });
});
