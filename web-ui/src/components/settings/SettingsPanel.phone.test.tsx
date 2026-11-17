import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { SettingsPanel } from "./SettingsPanel";

vi.mock("@/hooks/useIsMobile", () => ({
  MOBILE_QUERY: "(max-width: 768px)",
  useIsMobile: () => true,
}));

// Only SettingsPanel's phone wrapper is under test; the real BackgroundSetting
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
 * R2F-07: on phones both Settings views sit on the `.settings-content` surface
 * that `wallpaper.css` turns into card alpha + chrome blur (R1F-06 covered the
 * desktop branch only).
 */
describe("SettingsPanel phone surfaces", () => {
  it("the section list renders inside .settings-content", () => {
    const { container } = renderAt("/settings");

    const surface = container.querySelector(".settings-content");
    expect(surface).not.toBeNull();
    expect(surface).toContainElement(screen.getByText("Background"));
  });

  it("a section view renders inside .settings-content", () => {
    const { container } = renderAt("/settings/background");

    const surface = container.querySelector(".settings-content");
    expect(surface).not.toBeNull();
    expect(surface).toContainElement(screen.getByTestId("bg-setting"));
  });

  it("the desktop content column wrapper is absent on phones", () => {
    const { container } = renderAt("/settings/background");

    expect(container.querySelector(".settings-content__inner")).toBeNull();
  });
});
