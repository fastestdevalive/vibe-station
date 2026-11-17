import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { SettingsPanel } from "./SettingsPanel";

vi.mock("@/hooks/useIsMobile", () => ({
  MOBILE_QUERY: "(max-width: 768px)",
  useIsMobile: () => false,
}));

// Only SettingsPanel's desktop wrapper is under test; the real BackgroundSetting
// would pull the wallpaper catalog over the network.
vi.mock("./BackgroundSetting", () => ({
  BackgroundSetting: () => <div data-testid="bg-setting" />,
}));

const api = createMockApi() as never;

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<SettingsPanel api={api} />} />
        <Route path="/settings/:sectionId" element={<SettingsPanel api={api} />} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * R6F-01: on desktop the section content sits in one capped, centred column
 * (`.settings-content__inner`) inside the full-width `.settings-content`
 * scroller, so the Background preview no longer fills ~1000px on wide windows.
 */
describe("SettingsPanel desktop content column", () => {
  it("wraps the section in .settings-content__inner, inside the scroller", () => {
    const { container } = renderAt("/settings/background");

    const scroller = container.querySelector<HTMLElement>(".settings-content");
    const inner = container.querySelector<HTMLElement>(".settings-content__inner");
    expect(scroller).not.toBeNull();
    expect(inner).not.toBeNull();
    expect(scroller).toContainElement(inner);
    expect(inner).toContainElement(screen.getByTestId("bg-setting"));
  });
});
