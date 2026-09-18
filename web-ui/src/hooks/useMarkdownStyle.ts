import { useEffect } from "react";
import { create } from "zustand";
import { api } from "@/api";
import type { MarkdownStyle } from "@/api/types";

/**
 * Daemon-synced Markdown style overrides, applied as an inline `<style>` block
 * layered on top of the active theme's per-theme `--md-*` defaults.
 *
 * The override layer targets `.workspace-markdown-preview` — the single class
 * shared by chat bubbles AND the file-preview `.md` pane — so one CSS layer
 * covers every rendered Markdown surface (requirement 7).
 *
 * A `dirty` flag is true from the first local edit until the next successful
 * `PATCH /settings` commit. While dirty, incoming `settings:updated` payloads
 * for `markdownStyle` are ignored so another tab's change — or the echo of
 * this client's own in-flight PATCH — cannot clobber an in-progress,
 * uncommitted draft. The committed value re-syncs once the pending PATCH
 * resolves (dirty flips back to false and subsequent events apply).
 */
export function buildMarkdownStyleCss(style: MarkdownStyle): string {
  const vars: Record<string, string> = {};

  for (const level of ["h1", "h2", "h3", "h4", "h5", "h6"] as const) {
    const h = style[level];
    if (!h) continue;
    if (h.size !== undefined) vars[`--md-${level}-size`] = h.size;
    if (h.color !== undefined) vars[`--md-${level}-color`] = h.color;
    if (h.weight !== undefined) vars[`--md-${level}-weight`] = String(h.weight);
  }

  if (style.bold) {
    if (style.bold.weight !== undefined) vars["--md-bold-weight"] = String(style.bold.weight);
    if (style.bold.color !== undefined) vars["--md-bold-color"] = style.bold.color;
  }
  if (style.italic) {
    if (style.italic.style !== undefined) vars["--md-italic-style"] = style.italic.style;
    if (style.italic.color !== undefined) vars["--md-italic-color"] = style.italic.color;
  }
  if (style.inlineCode) {
    if (style.inlineCode.bg !== undefined) vars["--md-inline-code-bg"] = style.inlineCode.bg;
    if (style.inlineCode.color !== undefined) vars["--md-inline-code-color"] = style.inlineCode.color;
  }
  if (style.codeBlock) {
    if (style.codeBlock.bg !== undefined) vars["--md-code-block-bg"] = style.codeBlock.bg;
    if (style.codeBlock.color !== undefined) vars["--md-code-block-color"] = style.codeBlock.color;
    if (style.codeBlock.border !== undefined) vars["--md-code-block-border"] = style.codeBlock.border;
  }
  if (style.codeFontFamily !== undefined) vars["--md-code-font-family"] = style.codeFontFamily;
  if (style.blockquote) {
    if (style.blockquote.border !== undefined) vars["--md-blockquote-border"] = style.blockquote.border;
    if (style.blockquote.color !== undefined) vars["--md-blockquote-color"] = style.blockquote.color;
  }
  if (style.link?.color !== undefined) vars["--md-link-color"] = style.link.color;

  const entries = Object.entries(vars);
  if (entries.length === 0) return "";
  const decls = entries.map(([k, v]) => `  ${k}: ${v};`).join("\n");
  return `.workspace-markdown-preview {\n${decls}\n}\n`;
}

const TOP_LEVEL_FIELDS = ["codeFontFamily"] as const;

/**
 * Set a single field in a `MarkdownStyle` copy. `path` is `group.field`
 * (e.g. `"h1.size"`) or a bare top-level field (`"codeFontFamily"`). A
 * `value` of `undefined` clears that field (falling back to the theme default).
 */
export function setMarkdownStyleField(
  style: MarkdownStyle,
  path: string,
  value: string | number | undefined,
): MarkdownStyle {
  const next: MarkdownStyle = { ...style };
  const dot = path.indexOf(".");

  if (dot === -1) {
    if (TOP_LEVEL_FIELDS.includes(path as (typeof TOP_LEVEL_FIELDS)[number])) {
      if (value === undefined) delete next[path as "codeFontFamily"];
      else next[path as "codeFontFamily"] = value as string;
    }
    return next;
  }

  const group = path.slice(0, dot);
  const field = path.slice(dot + 1);
  const current = { ...((next as Record<string, unknown>)[group] as Record<string, string | number> | undefined) };
  if (value === undefined) delete current[field];
  else current[field] = value as string | number;
  if (Object.keys(current).length === 0) delete (next as Record<string, unknown>)[group];
  else (next as Record<string, unknown>)[group] = current;
  return next;
}

interface MarkdownStyleStore {
  /** The merged, currently-applied overrides (server value + in-progress edits). */
  style: MarkdownStyle;
  /** True from the first local edit until the next successful PATCH resolves. */
  dirty: boolean;
  setStyle: (style: MarkdownStyle) => void;
  setDirty: (dirty: boolean) => void;
}

const useMarkdownStyleStore = create<MarkdownStyleStore>()((set) => ({
  style: {},
  dirty: false,
  setStyle: (style) => set({ style, dirty: true }),
  setDirty: (dirty) => set({ dirty }),
}));

let styleEl: HTMLStyleElement | null = null;

function applyStyleCss(css: string): void {
  if (typeof document === "undefined") return;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.setAttribute("data-vst-markdown-style", "");
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = css;
}

// Keep the injected `<style>` in sync with the store's applied overrides.
useMarkdownStyleStore.subscribe((state) => {
  applyStyleCss(buildMarkdownStyleCss(state.style));
});

/**
 * Module-level boot singleton: all consumers share ONE `GET /settings` seed and
 * ONE `settings:updated` WS subscription (mirrors `useTheme.ts`), so a single
 * boot fans the server value out to every mounted instance.
 */
let booted = false;
let bootOff: (() => void) | null = null;

function boot(): void {
  if (booted) return;
  booted = true;

  void (async () => {
    try {
      const settings = await api.getSettings();
      useMarkdownStyleStore.setState({ style: settings.markdownStyle ?? {}, dirty: false });
    } catch {
      // Server unreachable — keep theme defaults; a later `settings:updated`
      // or reconnect reconciles.
    }
  })();

  bootOff = api.on("settings:updated", (ev) => {
    if (ev.type !== "settings:updated") return;
    // `markdownStyle` may be absent (a theme-only change) OR `undefined`/`null`
    // (a reset echo). Distinguish "field present" from "field absent" so a reset
    // actually clears the overrides.
    if (!("markdownStyle" in ev)) return;
    if (useMarkdownStyleStore.getState().dirty) return; // never clobber a local draft
    useMarkdownStyleStore.setState({ style: ev.markdownStyle ?? {}, dirty: false });
  });
}

export function useMarkdownStyle() {
  useEffect(() => {
    boot();
  }, []);

  const style = useMarkdownStyleStore((s) => s.style);
  const dirty = useMarkdownStyleStore((s) => s.dirty);

  /** Update a single field locally — marks `dirty`, re-renders the preview
   *  instantly, no network call. Call `commit()` on blur/change-end. */
  const set = (path: string, value: string | number | undefined) => {
    const current = useMarkdownStyleStore.getState().style;
    useMarkdownStyleStore.getState().setStyle(setMarkdownStyleField(current, path, value));
  };

  /** Commit the current draft to the server (PATCH /settings). Clears `dirty`
   *  on success so the next `settings:updated` re-syncs. */
  const commit = async () => {
    const { style: current } = useMarkdownStyleStore.getState();
    try {
      await api.updateSettings({ markdownStyle: current });
      useMarkdownStyleStore.getState().setDirty(false);
    } catch {
      // Keep dirty; the user can retry, or a later settings:updated reconciles.
    }
  };

  /** Reset all Markdown overrides back to the active theme's defaults. */
  const reset = async () => {
    try {
      await api.updateSettings({ resetMarkdownStyle: true });
      useMarkdownStyleStore.setState({ style: {}, dirty: false });
    } catch {
      // Keep the current state; retry is up to the caller.
    }
  };

  const hasOverrides = Object.keys(style).length > 0;

  return { style, dirty, set, commit, reset, hasOverrides };
}

/** Test-only: reset the module-level boot singleton + store for isolation. */
export function __resetMarkdownStyleForTests(): void {
  booted = false;
  bootOff?.();
  bootOff = null;
  useMarkdownStyleStore.setState({ style: {}, dirty: false });
  if (typeof document !== "undefined" && styleEl) {
    styleEl.textContent = "";
  }
}
