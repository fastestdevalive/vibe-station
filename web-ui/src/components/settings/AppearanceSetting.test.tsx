import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi, type MockApi } from "@/api/mock";
import { AppearanceSetting } from "./AppearanceSetting";
import { DiffView } from "@/components/preview/DiffView";
import { CodeView } from "@/components/preview/CodeView";
import { useThemeStore } from "@/hooks/useThemeStore";
import { __resetThemeSyncForTests } from "@/hooks/useTheme";

let testApi: MockApi;

vi.mock("@/api", () => ({
  get api() {
    return testApi;
  },
  createMockApi,
}));

beforeEach(() => {
  __resetThemeSyncForTests();
  testApi = createMockApi();
});

const CODE = `export function login(user: { token?: string }) {
  return user?.token ? createSession(user) : null;
}`;

const OLD = `function login(user) {
  if (user.token) {
    return session.create(user);
  }
}`;

const NEW = `function login(user) {
  if (user?.token) {
    return session.create(user);
  }
}`;

/** First inline `style` color found inside a highlighted element's HTML. */
function firstTokenColor(html: string): string | null {
  const m = html.match(/style="color:\s*([^";]+)/i);
  return m ? m[1]!.trim() : null;
}

async function highlightedColor(container: HTMLElement, testId: string, cls: string): Promise<string> {
  let last: string | null = null;
  await waitFor(() => {
    const el = container.querySelector(`[data-testid="${testId}"] .${cls}`);
    expect(el?.innerHTML ?? "").toContain('style="color:');
    last = firstTokenColor(el!.innerHTML!);
  });
  return last!;
}

describe("AppearanceSetting theme picker (3.T1 / 3.T3)", () => {
  it("3.T1: switching the theme updates DiffView + CodeView Shiki colors without remounting", async () => {
    // Render AppearanceSetting (the picker) in the same tree as the two
    // components from the original stale-color bug, so a theme change must
    // propagate live to every mounted instance — no remount, no refresh.
    const { container } = render(
      <div>
        <AppearanceSetting />
        <div data-testid="codeview">
          <CodeView code={CODE} filePath="auth.ts" />
        </div>
        <div data-testid="diffview">
          <DiffView oldText={OLD} newText={NEW} filePath="auth.ts" />
        </div>
      </div>,
    );

    const codeColorBefore = await highlightedColor(container, "codeview", "workspace-code-content--shiki");
    const diffColorBefore = await highlightedColor(container, "diffview", "diff-line-text--shiki");
    expect(useThemeStore.getState().appearance).toBe("dark");

    // Switch to a light theme via the picker swatch.
    const lightSwatch = await screen.findByRole("button", { name: /Vibestation Light/i });
    fireEvent.click(lightSwatch);

    // The shared store flips appearance; both components re-highlight with the
    // light theme without being unmounted.
    await waitFor(() => expect(useThemeStore.getState().appearance).toBe("light"));
    await waitFor(() => {
      expect(firstTokenColor(container.querySelector('[data-testid="codeview"] .workspace-code-content--shiki')!.innerHTML!)).not.toBe(codeColorBefore);
    });
    await waitFor(() => {
      expect(firstTokenColor(container.querySelector('[data-testid="diffview"] .diff-line-text--shiki')!.innerHTML!)).not.toBe(diffColorBefore);
    });

    expect(document.documentElement.dataset.appearance).toBe("light");
  });

  it("3.T3: hovering a non-committed swatch previews it but does not PATCH or change the root data-theme", async () => {
    const updateSpy = vi.spyOn(testApi, "updateSettings");
    const { container } = render(<AppearanceSetting />);

    // Wait for committed theme to settle (default vibestation-dark).
    await waitFor(() => expect(useThemeStore.getState().themeId).toBe("vibestation-dark"));
    const rootThemeBefore = document.documentElement.dataset.theme;

    const swatch = await screen.findByRole("button", { name: /Nord$/ });
    fireEvent.mouseEnter(swatch);

    // Preview panel now previews Nord (scoped), but the root is untouched.
    const previewScope = container.querySelector(".theme-scope");
    await waitFor(() => {
      expect(previewScope?.getAttribute("data-theme")).toBe("nord");
    });
    expect(document.documentElement.dataset.theme).toBe(rootThemeBefore);
    expect(updateSpy).not.toHaveBeenCalled();

    // Leaving the swatch falls back to the committed theme (touch-device case).
    fireEvent.mouseLeave(swatch);
    await waitFor(() => {
      expect(previewScope?.getAttribute("data-theme")).toBe("vibestation-dark");
    });
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
