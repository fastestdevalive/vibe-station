import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor, render } from "@testing-library/react";
import { createMockApi, type MockApi } from "@/api/mock";
import {
  useMarkdownStyle,
  buildMarkdownStyleCss,
  setMarkdownStyleField,
  __resetMarkdownStyleForTests,
} from "./useMarkdownStyle";
import { MarkdownView } from "@/components/preview/MarkdownView";

let testApi: MockApi;

vi.mock("@/api", () => ({
  get api() {
    return testApi;
  },
  createMockApi,
}));

beforeEach(() => {
  __resetMarkdownStyleForTests();
  testApi = createMockApi();
});

describe("useMarkdownStyle — buildMarkdownStyleCss (5.T1)", () => {
  it("emits a .workspace-markdown-preview-scoped block with the overridden --md-* vars", () => {
    const css = buildMarkdownStyleCss({
      h1: { color: "#ff0000", size: "1.5em" },
      bold: { color: "#00ff00" },
      codeBlock: { bg: "#111111" },
    });
    expect(css).toContain(".workspace-markdown-preview");
    expect(css).toContain("--md-h1-color: #ff0000;");
    expect(css).toContain("--md-h1-size: 1.5em;");
    expect(css).toContain("--md-bold-color: #00ff00;");
    expect(css).toContain("--md-code-block-bg: #111111;");
  });

  it("renders no CSS when there are no overrides (falls through to theme defaults)", () => {
    expect(buildMarkdownStyleCss({})).toBe("");
  });

  it("targets the exact class MarkdownView renders, covering chat + file-preview with one layer", () => {
    // The override block keys on `.workspace-markdown-preview` — the single
    // class shared by the file-preview `.md` pane (MarkdownView) and chat
    // bubbles (ToolRunSummary / markdown rendering). Prove MarkdownView emits
    // that class so one CSS layer covers both surfaces (requirement 7).
    const { container } = render(<MarkdownView source="# hi" />);
    const el = container.querySelector(".workspace-markdown-preview");
    expect(el).not.toBeNull();
    expect(buildMarkdownStyleCss({ h1: { color: "#fff" } })).toContain(
      ".workspace-markdown-preview",
    );
  });
});

describe("useMarkdownStyle — persistence + preview (5.T3)", () => {
  it("a local edit updates the preview/style without any network call, and commit PATCHes exactly once", async () => {
    const updateSpy = vi.spyOn(testApi, "updateSettings");
    const { result } = renderHook(() => useMarkdownStyle());

    await waitFor(() => expect(result.current.style).toEqual({}));

    act(() => {
      result.current.set("h1.color", "#ff0000");
    });
    // set() is local-only — the preview reflects it, dirty is set, NO PATCH.
    expect(result.current.style.h1?.color).toBe("#ff0000");
    expect(result.current.dirty).toBe(true);
    expect(updateSpy).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.commit();
    });

    // commit PATCHes the full draft once, on change-end (not per keystroke).
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith({ markdownStyle: { h1: { color: "#ff0000" } } });
    expect(result.current.dirty).toBe(false);
  });

  it("clears a field to fall back to the theme default when set(undefined)", async () => {
    const { result } = renderHook(() => useMarkdownStyle());
    await waitFor(() => expect(result.current.style.bold?.color).toBeUndefined());
    await act(async () => {
      result.current.set("bold.color", "#00ff00");
      await Promise.resolve();
    });
    expect(result.current.style.bold?.color).toBe("#00ff00");
    await act(async () => {
      result.current.set("bold.color", undefined);
      await Promise.resolve();
    });
    expect(result.current.style.bold?.color).toBeUndefined();
    expect(result.current.style.bold).toBeUndefined();
  });
});

describe("useMarkdownStyle — WS handling (5.T4)", () => {
  it("a settings:updated event does NOT clobber a dirty, uncommitted draft", async () => {
    const { result } = renderHook(() => useMarkdownStyle());
    await waitFor(() => expect(result.current.dirty).toBe(false));

    act(() => result.current.set("h1.color", "#ff0000")); // local draft
    expect(result.current.dirty).toBe(true);

    // Another tab (or our own echo) pushes a different markdownStyle.
    act(() => {
      testApi.__test.emit({ type: "settings:updated", markdownStyle: { h1: { color: "#00ff00" } } });
    });

    // Draft survives; the WS value is ignored while dirty.
    expect(result.current.style.h1?.color).toBe("#ff0000");
    expect(result.current.dirty).toBe(true);
  });

  it("re-syncs to the server value once the pending PATCH resolves (dirty clears)", async () => {
    const { result } = renderHook(() => useMarkdownStyle());
    await waitFor(() => expect(result.current.dirty).toBe(false));

    act(() => result.current.set("h1.color", "#ff0000"));
    await act(async () => {
      await result.current.commit(); // resolves → dirty false
    });
    expect(result.current.dirty).toBe(false);

    // After commit, a genuine external change now applies.
    act(() => {
      testApi.__test.emit({ type: "settings:updated", markdownStyle: { bold: { color: "#123456" } } });
    });
    expect(result.current.style.bold?.color).toBe("#123456");
  });
});

describe("useMarkdownStyle — reset to theme (5.T5)", () => {
  it("resetMarkdownStyle: true clears the server-side markdownStyle (not a no-op)", async () => {
    // Seed a previously-set server markdownStyle.
    testApi.__test.setSettings({ markdownStyle: { h1: { color: "#ff0000" } } });
    const { result } = renderHook(() => useMarkdownStyle());
    await waitFor(() => expect(result.current.style.h1?.color).toBe("#ff0000"));

    const updateSpy = vi.spyOn(testApi, "updateSettings");

    await act(async () => {
      await result.current.reset();
    });

    // The client PATCHes with the dedicated reset flag…
    expect(updateSpy).toHaveBeenCalledWith({ resetMarkdownStyle: true });
    // …and the mock cleared its persisted markdownStyle server-side.
    const settings = await testApi.getSettings();
    expect(settings.markdownStyle).toBeUndefined();
    // Local overrides are gone; the UI falls back to theme defaults.
    expect(result.current.style).toEqual({});
    expect(result.current.hasOverrides).toBe(false);
  });
});

describe("setMarkdownStyleField", () => {
  it("sets nested and top-level fields, and deletes empty groups", () => {
    const s1 = setMarkdownStyleField({}, "h2.size", "1.5em");
    expect(s1).toEqual({ h2: { size: "1.5em" } });
    const s2 = setMarkdownStyleField(s1, "h2.color", "#000");
    expect(s2).toEqual({ h2: { size: "1.5em", color: "#000" } });
    const s3 = setMarkdownStyleField(s2, "h2.color", undefined);
    expect(s3).toEqual({ h2: { size: "1.5em" } });
    const s4 = setMarkdownStyleField(s3, "h2.size", undefined);
    expect(s4).toEqual({});
    const s5 = setMarkdownStyleField({}, "codeFontFamily", "monospace");
    expect(s5).toEqual({ codeFontFamily: "monospace" });
    const s6 = setMarkdownStyleField(s5, "codeFontFamily", undefined);
    expect(s6).toEqual({});
  });
});

describe("workspace.css diff-scope (5.T2)", () => {
  const css = readFileSync(join(__dirname, "../styles/workspace.css"), "utf8");

  it("the markdown rules read --md-* vars, not hardcoded values", () => {
    const h1 = css.match(/\.workspace-markdown-preview h1 \{([^}]*)\}/)?.[1] ?? "";
    expect(h1).toContain("var(--md-h1-size)");
    expect(h1).toContain("var(--md-h1-weight)");
    expect(h1).toContain("var(--md-h1-color)");
    expect(css).toContain("font-weight: var(--md-bold-weight);");
    expect(css).toContain("font-style: var(--md-italic-style);");
    expect(css).toContain("background: var(--md-code-block-bg);");
    expect(css).toContain("color: var(--md-blockquote-color);");
    expect(css).toContain("color: var(--md-link-color);");
  });

  it("the 3 Phase-2 [data-appearance] blocks are untouched and still key on data-appearance", () => {
    // git-status rows (~1908-1917) + hljs light palette (~2609-2655) +
    // markdown h5/h6 overrides (~3050-3060) all key on data-appearance.
    const appearanceMatches = css.match(/\[data-appearance="(dark|light)"\]/g) ?? [];
    expect(appearanceMatches.length).toBeGreaterThanOrEqual(3);
    // No leftover legacy [data-theme="dark"|"light"] blocks (rename consequence).
    expect(css).not.toContain('[data-theme="dark"]');
    expect(css).not.toContain('[data-theme="light"]');
  });

  it("does not define or reorder --status-*/--pr-* tokens (those live in tokens.css)", () => {
    // workspace.css never defines the status tokens — the markdown section must
    // not have introduced any.
    const mdSection = css.slice(css.indexOf("/* Markdown — aligned"), css.indexOf(".image-zoom-overlay"));
    expect(mdSection).not.toContain("--status-");
    expect(mdSection).not.toContain("--pr-");
  });
});
