import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect } from "vitest";
import axe from "axe-core";
import { TopBar } from "@/components/layout/TopBar";
import { PaneOutletProvider } from "@/components/layout/paneOutlets";
import { Dialog } from "@/components/dialogs/Dialog";
import { MessageList } from "@/components/chat/MessageList";
import type { NormalizedEvent } from "@/api/types";

describe("a11y smoke", () => {
  it("TopBar has no axe violations", async () => {
    const { container } = render(
      <MemoryRouter>
        {/* TopBar always renders inside one in the real app (Workspace.tsx) —
            it now hosts a ToolbarOutlet (WorkspaceCanvas's portaled
            toolbar), which needs the registry context. */}
        <PaneOutletProvider>
          <TopBar
            projects={[]}
            worktrees={[]}
            isMobile={false}
            onToggleLeftSidebar={() => {}}
            leftSidebarCollapsed={false}
            mobileSidebarOpen={false}
            onOpenQuickOpen={() => {}}
          />
        </PaneOutletProvider>
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

  // 2.T9 — the chat list is a `role="feed"` of `role="article"` rows; confirm
  // axe is happy with that structure (it previously used `role="log"`).
  it("MessageList (feed/article roles) has no axe violations", async () => {
    const events: NormalizedEvent[] = [
      { id: "u1", sessionId: "s1", ts: "", provider: "claude", kind: "user", text: "Hi there", turnId: "t1" },
      { id: "a1", sessionId: "s1", ts: "", provider: "claude", kind: "text", role: "assistant", text: "Hello!", turnId: "t1" },
      { id: "u2", sessionId: "s1", ts: "", provider: "claude", kind: "user", text: "Show me a file", turnId: "t2" },
      { id: "a2", sessionId: "s1", ts: "", provider: "claude", kind: "text", role: "assistant", text: "Here you go", turnId: "t2" },
    ];
    const { container } = render(<MessageList events={events} pending={[]} />);
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });
});
