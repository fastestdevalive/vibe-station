import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect } from "vitest";
import axe from "axe-core";
import { TopBar } from "@/components/layout/TopBar";
import { Dialog } from "@/components/dialogs/Dialog";

describe("a11y smoke", () => {
  it("TopBar has no axe violations", async () => {
    const { container } = render(
      <MemoryRouter>
        <TopBar
          projects={[]}
          worktrees={[]}
          sessions={[]}
          isMobile={false}
          onToggleLeftSidebar={() => {}}
          leftSidebarCollapsed={false}
          mobileSidebarOpen={false}
          onOpenQuickOpen={() => {}}
        />
      </MemoryRouter>,
    );
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });

  it("Dialog has no axe violations", async () => {
    const { container } = render(
      <Dialog open title="Test" onClose={() => {}}>
        <p>Hello</p>
      </Dialog>,
    );
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });
});
