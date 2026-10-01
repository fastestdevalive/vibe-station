import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { APP_STORES, resetAppSingletons, setThemeRoot, getThemeRoot, setStyleHost, getStyleHost } from "./demoRuntime";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useServerStore } from "@/hooks/useServerStore";
import { useModesStore } from "@/store/modesStore";
import { useThemeStore } from "@/hooks/useThemeStore";
import { useMarkdownStyleStore, reapplyMarkdownStyle } from "@/hooks/useMarkdownStyle";
import { themes } from "@/theme/registry";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "gallery" || name === "node_modules") continue;
      sourceFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

const plain = (s: unknown) => JSON.parse(JSON.stringify(s, (_k, v) => (typeof v === "function" ? undefined : v instanceof Map ? [...v] : v instanceof Set ? [...v] : v)));

describe("demoRuntime", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    setThemeRoot(null);
    setStyleHost(null);
  });

  it("APP_STORES lists exactly the zustand stores declared in src", () => {
    const root = join(__dirname, "..");
    let n = 0;
    for (const f of sourceFiles(root)) {
      n += (readFileSync(f, "utf8").match(/=\s*create(?:<[^>]*>)?\(/g) ?? []).length;
    }
    expect(APP_STORES.length).toBe(n);
  });

  it("resetAppSingletons returns all six stores to getInitialState()", () => {
    const initial = APP_STORES.map((s) => plain((s as { getInitialState(): unknown }).getInitialState()));
    useWorkspaceStore.setState({ activeWorktreeId: "wt-x", activeSessionId: "s-x" });
    useServerStore.getState().replaceAll({ projects: [], worktrees: [], sessions: [] });
    useModesStore.setState({ loaded: true });
    useThemeStore.getState().setThemeId(themes.find((t) => t.id !== useThemeStore.getState().themeId)!.id);
    useMarkdownStyleStore.getState().setStyle({ h1: { color: "#fff" } } as never);
    expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-x");

    localStorage.clear(); // a mount seeds (here: empties) the storage before resetting
    resetAppSingletons();

    const after = APP_STORES.map((s) => plain((s as { getState(): unknown }).getState()));
    APP_STORES.forEach((_s, i) => {
      // persisted stores rehydrate from the (empty) storage, so compare to the pristine initial state
      expect(after[i]).toEqual(initial[i]);
    });
  });

  it("persisted stores re-read the seeded storage instead of the initial state", () => {
    const name = useWorkspaceStore.persist.getOptions().name as string;
    localStorage.setItem(name, JSON.stringify({ state: { leftSidebarWidthPx: 333 }, version: useWorkspaceStore.persist.getOptions().version }));
    resetAppSingletons();
    expect(useWorkspaceStore.getState().leftSidebarWidthPx).toBe(333);
    expect(JSON.parse(localStorage.getItem(name)!).state.leftSidebarWidthPx).toBe(333);
  });

  it("theme writes go to the theme root, and to <html> by default", () => {
    const el = document.createElement("div");
    setThemeRoot(el);
    expect(getThemeRoot()).toBe(el);
    const other = themes[1]!.id;
    useThemeStore.getState().setThemeId(other);
    useThemeStore.getState().setFont("sans");
    expect(el.dataset.theme).toBe(other);
    expect(el.style.getPropertyValue("--font-family")).toBe("var(--font-sans)");
    expect(document.documentElement.dataset.theme).not.toBe(other);

    setThemeRoot(null);
    expect(getThemeRoot()).toBe(document.documentElement);
    useThemeStore.getState().setThemeId(other);
    expect(document.documentElement.dataset.theme).toBe(other);
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.appearance;
    document.documentElement.style.removeProperty("--font-family");
  });

  it("the markdown <style> lives in the style host and is recreated when its host is gone", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    setStyleHost(host);
    resetAppSingletons(); // drops any style element left in document.head by earlier tests
    expect(getStyleHost()).toBe(host);
    useMarkdownStyleStore.getState().setStyle({ h1: { color: "#123456" } } as never);
    expect(host.querySelector("style[data-vst-markdown-style]")?.textContent).toContain("#123456");
    expect(host.querySelector("style[data-vst-markdown-style]")?.textContent).toMatch(/^@scope \{/);
    expect(document.head.querySelector("style[data-vst-markdown-style]")).toBeNull();
    host.remove();
    const host2 = document.createElement("div");
    document.body.appendChild(host2);
    setStyleHost(host2);
    reapplyMarkdownStyle();
    expect(host2.querySelector("style[data-vst-markdown-style]")?.textContent).toContain("#123456");
    host2.remove();
    useMarkdownStyleStore.getState().setStyle({});
    setStyleHost(null);
    document.head.querySelectorAll("style[data-vst-markdown-style]").forEach((n) => n.remove());
  });
});
