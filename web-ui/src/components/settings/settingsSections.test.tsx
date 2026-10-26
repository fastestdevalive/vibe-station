import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TopBar } from "@/components/layout/TopBar";
import { PaneOutletProvider } from "@/components/layout/paneOutlets";
import { settingsSectionLabelFor, SETTINGS_SECTION_LABELS } from "./settingsSections";

describe("settingsSectionLabelFor", () => {
  it("covers the sections that previously fell back to the raw id", () => {
    for (const id of ["updates", "lsp", "doctor", "about"]) {
      expect(SETTINGS_SECTION_LABELS[id]).toBeTruthy();
    }
  });

  it("falls back to the id for an unknown section", () => {
    expect(settingsSectionLabelFor("nope")).toBe("nope");
  });

  it("mobile TopBar for /settings/updates shows 'Updates', not the raw id", () => {
    const sectionId = "/settings/updates".split("/")[2]!;
    render(
      <MemoryRouter>
        <PaneOutletProvider>
          <TopBar
            projects={[]}
            isMobile
            layoutMode="settings"
            settingsSectionLabel={settingsSectionLabelFor(sectionId)}
            onToggleLeftSidebar={() => {}}
            leftSidebarCollapsed={false}
            mobileSidebarOpen={false}
            onOpenQuickOpen={() => {}}
          />
        </PaneOutletProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText("Updates")).toBeInTheDocument();
    expect(screen.queryByText("updates")).toBeNull();
  });
});
