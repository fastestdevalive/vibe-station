import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useThemeStore } from "@/hooks/useThemeStore";
import { themeById } from "@/theme/registry";
import {
  HTML_CHAT_MAX_BYTES,
  HTML_FILE_MAX_BYTES,
  HTML_IFRAME_SANDBOX,
} from "./htmlDocument";
import { HtmlView, isOverHtmlCap } from "./HtmlView";

const FORBIDDEN_SANDBOX = [
  "allow-scripts",
  "allow-same-origin",
  "allow-forms",
  "allow-top-navigation",
  "allow-modals",
];

function renderView(props: Partial<React.ComponentProps<typeof HtmlView>> = {}) {
  return render(<HtmlView source="<p>hi</p>" variant="file" {...props} />);
}

describe("HtmlView sandbox invariant (2.T6)", () => {
  it("sandbox attr is exactly allow-popups allow-popups-to-escape-sandbox", () => {
    const { container } = renderView();
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe(HTML_IFRAME_SANDBOX);
  });

  it("sandbox never contains scripts/same-origin/forms/top-nav/modals", () => {
    const { container } = renderView();
    const frame = container.querySelector("iframe")!;
    for (const flag of FORBIDDEN_SANDBOX) {
      expect(HTML_IFRAME_SANDBOX).not.toContain(flag);
      expect(frame.getAttribute("sandbox")).not.toContain(flag);
    }
  });

  it("has no src attribute", () => {
    const { container } = renderView();
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBeNull();
  });

  it("srcdoc contains the CSP meta and omits <script", () => {
    const { container } = renderView({ source: '<script>alert(1)</script><h1>Hi</h1>' });
    const frame = container.querySelector("iframe")!;
    const srcdoc = frame.getAttribute("srcdoc")!;
    expect(srcdoc).toContain("Content-Security-Policy");
    expect(srcdoc).not.toContain("<script");
  });
});

describe("HtmlView theme (2.T7)", () => {
  it("follows the theme registry bg/fg and color-scheme", () => {
    act(() => useThemeStore.getState().setThemeId("vibestation-light"));
    const { container } = renderView();
    const frame = container.querySelector("iframe")!;
    const srcdoc = frame.getAttribute("srcdoc")!;
    expect(srcdoc).toContain("color-scheme:light");
    const bg = themeById["vibestation-light"]!.cssVars["--bg-primary"];
    expect(srcdoc).toContain(bg);
  });

  it("changes srcdoc when the theme changes to dark", () => {
    act(() => useThemeStore.getState().setThemeId("vibestation-light"));
    const { container } = renderView();
    const lightSrc = container.querySelector("iframe")!.getAttribute("srcdoc")!;
    act(() => useThemeStore.getState().setThemeId("vibestation-dark"));
    const darkSrc = container.querySelector("iframe")!.getAttribute("srcdoc")!;
    expect(darkSrc).not.toBe(lightSrc);
    expect(darkSrc).toContain("color-scheme:dark");
    const bg = themeById["vibestation-dark"]!.cssVars["--bg-primary"];
    expect(darkSrc).toContain(bg);
  });

  it("falls back to the default theme for an unknown id without throwing", () => {
    act(() => useThemeStore.getState().setThemeId("not-a-real-theme"));
    expect(() => renderView()).not.toThrow();
    const { container } = renderView();
    const srcdoc = container.querySelector("iframe")!.getAttribute("srcdoc")!;
    const bg = themeById["vibestation-dark"]!.cssVars["--bg-primary"];
    expect(srcdoc).toContain(bg);
  });

  it("Light canvas click sets aria-pressed and omits the canvas defaults", () => {
    act(() => useThemeStore.getState().setThemeId("vibestation-light"));
    const { container } = renderView();
    const btn = container.querySelector(".html-view__light-btn")!;
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    const srcdoc = container.querySelector("iframe")!.getAttribute("srcdoc")!;
    expect(srcdoc).not.toContain(":where(html,body){background");
  });
});

describe("HtmlView chat variant (2.T8)", () => {
  it("Expand toggles data-expanded and label", () => {
    const { container } = renderView({ variant: "chat" });
    const view = container.querySelector(".html-view--chat")!;
    expect(view.getAttribute("data-expanded")).toBeNull();
    const btn = container.querySelector(".html-view__expand-btn")!;
    expect(btn.textContent).toBe("Expand");
    fireEvent.click(btn);
    expect(view.getAttribute("data-expanded")).toBe("true");
    expect(container.querySelector(".html-view__expand-btn")!.textContent).toBe("Collapse");
  });

  it("oversize chat source shows notice and no iframe", () => {
    const big = "<p>x</p>\n".repeat(Math.ceil(HTML_CHAT_MAX_BYTES / 9) + 1);
    expect(isOverHtmlCap(big, "chat")).toBe(true);
    const { container } = renderView({ source: big, variant: "chat" });
    expect(container.querySelector(".html-view__notice")).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("oversize file source shows notice and no iframe", () => {
    const big = "<p>x</p>\n".repeat(Math.ceil(HTML_FILE_MAX_BYTES / 9) + 1);
    expect(isOverHtmlCap(big, "file")).toBe(true);
    const { container } = renderView({ source: big, variant: "file" });
    expect(container.querySelector(".html-view__notice")).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
  });
});
