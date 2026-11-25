import { describe, it, expect } from "vitest";
import {
  PRESET_BUG_FIX_TEXT,
  PRESET_PLANNING_TEXT,
  contextFieldReducer,
  contextTooLong,
  hasCustomContent,
  initContextField,
  CONTEXT_TOO_LONG_MESSAGE,
  canRestoreStash,
  selectionOf,
  matchPreset,
  presetIdForSave,
  type ContextFieldAction,
  type ContextFieldState,
} from "./modeContextPresets";

function run(state: ContextFieldState, ...actions: ContextFieldAction[]): ContextFieldState {
  return actions.reduce(contextFieldReducer, state);
}

describe("matchPreset / hasCustomContent", () => {
  it.each([
    [PRESET_BUG_FIX_TEXT, "bug-fix-with-pr"],
    [PRESET_PLANNING_TEXT, "planning-no-pr"],
    [`  ${PRESET_BUG_FIX_TEXT}\n\n`, "bug-fix-with-pr"],
    [`${PRESET_PLANNING_TEXT}\r\n`, "planning-no-pr"],
    [PRESET_BUG_FIX_TEXT.replace("bug.", "bug. "), null],
    ["", null],
    ["custom", null],
  ])("matchPreset(%j) = %s", (text, expected) => {
    expect(matchPreset(text)).toBe(expected);
  });

  it.each([
    ["", false],
    ["   \n\t", false],
    [PRESET_BUG_FIX_TEXT, false],
    [`${PRESET_PLANNING_TEXT} `, false],
    ["do the thing", true],
  ])("hasCustomContent(%j) = %s", (text, expected) => {
    expect(hasCustomContent(text)).toBe(expected);
  });

  it("presetIdForSave mirrors matchPreset", () => {
    expect(presetIdForSave(PRESET_BUG_FIX_TEXT)).toBe("bug-fix-with-pr");
    expect(presetIdForSave("mine")).toBeUndefined();
  });
});

describe("contextTooLong (10 000 bytes after trim, like the daemon)", () => {
  it("counts bytes, not characters", () => {
    expect(contextTooLong("x".repeat(10_000))).toBe(false);
    expect(contextTooLong("x".repeat(10_001))).toBe(true);
    // 3 bytes each in UTF-8: 3 334 chars = 10 002 bytes.
    expect(contextTooLong("€".repeat(3_334))).toBe(true);
    expect(contextTooLong("€".repeat(3_333))).toBe(false);
  });
  it("ignores surrounding whitespace", () => {
    expect(contextTooLong(`  ${"x".repeat(10_000)}\n\n`)).toBe(false);
  });
  it("the message is built from the limit", () => {
    expect(CONTEXT_TOO_LONG_MESSAGE).toBe("Context must be at most 10,000 bytes.");
  });
});

describe("initContextField", () => {
  it("new mode starts on the default preset", () => {
    const s = initContextField();
    expect(selectionOf(s)).toBe("bug-fix-with-pr");
    expect(s.text).toBe(PRESET_BUG_FIX_TEXT);
  });
  it("saved preset text opens on that preset", () => {
    expect(selectionOf(initContextField(PRESET_PLANNING_TEXT))).toBe("planning-no-pr");
  });
  it("saved custom text opens as Custom", () => {
    const s = initContextField("my own context");
    expect(selectionOf(s)).toBe("custom");
    expect(s.text).toBe("my own context");
  });
  it("saved empty context opens as Custom (empty)", () => {
    const s = initContextField("");
    expect(selectionOf(s)).toBe("custom");
    expect(s.text).toBe("");
  });
});

describe("contextFieldReducer", () => {
  it("typing that diverges selects Custom", () => {
    const s = run(initContextField(), { type: "type", text: `${PRESET_BUG_FIX_TEXT} More.` });
    expect(selectionOf(s)).toBe("custom");
  });

  it("typing back to exactly a preset re-selects that preset", () => {
    const s = run(
      initContextField(),
      { type: "type", text: "x" },
      { type: "type", text: PRESET_PLANNING_TEXT },
    );
    expect(selectionOf(s)).toBe("planning-no-pr");
  });

  it("Custom on preset text selects Custom without touching the text; typing a preset re-selects it", () => {
    const s = run(initContextField(), { type: "selectCustom" });
    expect(selectionOf(s)).toBe("custom");
    expect(s.text).toBe(PRESET_BUG_FIX_TEXT);
    expect(selectionOf(run(s, { type: "type", text: PRESET_PLANNING_TEXT }))).toBe("planning-no-pr");
  });

  it("clearing the text selects Custom; then a preset switches without asking", () => {
    const s = run(initContextField(), { type: "type", text: "" }, { type: "selectPreset", id: "planning-no-pr" });
    expect(s.pending).toBeNull();
    expect(s.text).toBe(PRESET_PLANNING_TEXT);
  });

  it("whitespace-only text never asks", () => {
    const s = run(initContextField(), { type: "type", text: "   \n" }, { type: "selectPreset", id: "bug-fix-with-pr" });
    expect(s.pending).toBeNull();
    expect(selectionOf(s)).toBe("bug-fix-with-pr");
  });

  it("preset → preset with untouched text is silent", () => {
    const s = run(initContextField(), { type: "selectPreset", id: "planning-no-pr" });
    expect(s.pending).toBeNull();
    expect(selectionOf(s)).toBe("planning-no-pr");
    expect(s.text).toBe(PRESET_PLANNING_TEXT);
  });

  it("a preset over custom content asks first and changes nothing yet", () => {
    const s = run(initContextField(), { type: "type", text: "mine" }, { type: "selectPreset", id: "planning-no-pr" });
    expect(s.pending).toBe("planning-no-pr");
    expect(selectionOf(s)).toBe("custom");
    expect(s.text).toBe("mine");
  });

  it("cancel keeps everything", () => {
    const s = run(
      initContextField(),
      { type: "type", text: "mine" },
      { type: "selectPreset", id: "planning-no-pr" },
      { type: "cancelDiscard" },
    );
    expect(s).toMatchObject({ pending: null, text: "mine", stash: null });
    expect(selectionOf(s)).toBe("custom");
  });

  it("confirm stashes the custom text and applies the preset; Custom restores it", () => {
    const confirmed = run(
      initContextField(),
      { type: "type", text: "mine" },
      { type: "selectPreset", id: "planning-no-pr" },
      { type: "confirmDiscard" },
    );
    expect(confirmed).toMatchObject({
      pending: null,
      text: PRESET_PLANNING_TEXT,
      stash: { text: "mine", presetText: PRESET_PLANNING_TEXT },
    });
    expect(selectionOf(confirmed)).toBe("planning-no-pr");
    expect(canRestoreStash(confirmed)).toBe(true);
    const restored = run(confirmed, { type: "selectCustom" });
    expect(restored).toMatchObject({ text: "mine", stash: null });
    expect(selectionOf(restored)).toBe("custom");
  });

  it("Custom keeps the current text when there is no stash", () => {
    const s = run(initContextField(), { type: "selectCustom" });
    expect(selectionOf(s)).toBe("custom");
    expect(s.text).toBe(PRESET_BUG_FIX_TEXT);
  });

  it("Custom keeps already-custom text even with a stash", () => {
    const s = run(
      initContextField(),
      { type: "type", text: "first" },
      { type: "selectPreset", id: "planning-no-pr" },
      { type: "confirmDiscard" },
      { type: "type", text: "second" },
      { type: "selectCustom" },
    );
    expect(s.text).toBe("second");
    expect(s.stash?.text).toBe("first");
  });

  it("a second discard overwrites the stash", () => {
    const s = run(
      initContextField(),
      { type: "type", text: "first" },
      { type: "selectPreset", id: "planning-no-pr" },
      { type: "confirmDiscard" },
      { type: "type", text: "second" },
      { type: "selectPreset", id: "bug-fix-with-pr" },
      { type: "confirmDiscard" },
    );
    expect(s.stash?.text).toBe("second");
  });

  it("clearing the box after a Replace, then Custom, stays empty (no restore)", () => {
    const s = run(
      initContextField(),
      { type: "type", text: "mine" },
      { type: "selectPreset", id: "planning-no-pr" },
      { type: "confirmDiscard" },
      { type: "type", text: "" },
      { type: "selectCustom" },
    );
    expect(s.text).toBe("");
    expect(selectionOf(s)).toBe("custom");
    expect(canRestoreStash(s)).toBe(false);
  });

  it("preset → preset after a Replace keeps the stash restorable", () => {
    const s = run(
      initContextField(),
      { type: "type", text: "mine" },
      { type: "selectPreset", id: "planning-no-pr" },
      { type: "confirmDiscard" },
      { type: "selectPreset", id: "bug-fix-with-pr" },
    );
    expect(s.pending).toBeNull();
    expect(canRestoreStash(s)).toBe(true);
    expect(run(s, { type: "selectCustom" }).text).toBe("mine");
  });

  it("reset drops the stash and starts fresh", () => {
    const s = run(
      initContextField(),
      { type: "type", text: "mine" },
      { type: "selectPreset", id: "planning-no-pr" },
      { type: "confirmDiscard" },
      { type: "reset" },
    );
    expect(s).toEqual(initContextField());
  });

  it("untouched saved custom text asks before a preset replaces it", () => {
    const s = run(initContextField("saved custom"), { type: "selectPreset", id: "bug-fix-with-pr" });
    expect(s.pending).toBe("bug-fix-with-pr");
    expect(s.text).toBe("saved custom");
  });
});
