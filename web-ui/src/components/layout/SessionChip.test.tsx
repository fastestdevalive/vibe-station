import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionChip } from "./SessionChip";

describe("SessionChip", () => {
  it("renders 2 rows: row 1 status+agent+time, row 2 worktree+project", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();

    const { container } = render(
      <SessionChip
        status="idle"
        pr={null}
        sessionLabel="Agent Alpha"
        worktreeLabel="feat/login"
        projectLabel="Project Zero"
        createdAt={twoDaysAgo}
      />
    );

    const row1 = container.querySelector(".session-chip__row-1");
    expect(row1).not.toBeNull();
    expect(row1?.querySelector(".status-dot")).not.toBeNull();
    expect(row1?.textContent).toContain("Agent Alpha");
    expect(row1?.textContent).toContain("2d");

    const row2 = container.querySelector(".session-chip__row-2");
    expect(row2).not.toBeNull();
    expect(row2?.textContent).toContain("feat/login");
    expect(row2?.textContent).toContain("Project Zero");
  });

  it("renders direct agent with a distinctive direct tag", () => {
    const { container } = render(
      <SessionChip
        status="idle"
        pr={null}
        sessionLabel="Agent Direct"
        projectLabel="Project Zero"
        isDirect={true}
      />,
    );

    const directTag = container.querySelector(".session-chip__direct-tag");
    expect(directTag).not.toBeNull();
    expect(directTag?.textContent).toBe("direct");
    expect(container.querySelector(".session-chip--direct")).not.toBeNull();
  });

  it("handles click and href navigation properly", async () => {
    const onClick = vi.fn();
    render(
      <SessionChip
        status="idle"
        pr={null}
        sessionLabel="Agent Click"
        worktreeLabel="main"
        href="/worktree/wt-click"
        onClick={onClick}
      />,
    );

    const link = screen.getByRole("link", { name: /Agent Click/i });
    expect(link).toHaveAttribute("href", "/worktree/wt-click");
    await userEvent.click(link);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders bare mode icon without terminal frame for json channel", () => {
    const { container } = render(
      <SessionChip
        status="idle"
        pr={null}
        sessionLabel="Claude Rich Chat"
        worktreeLabel="feat/rich-chat"
        modeIconKey="claude"
        channel="json"
      />,
    );

    expect(container.querySelector(".mode-icon")).not.toBeNull();
    expect(container.querySelector(".mode-icon--terminal")).toBeNull();
  });

  it("renders mode icon with terminal frame for pty channel", () => {
    const { container } = render(
      <SessionChip
        status="idle"
        pr={null}
        sessionLabel="Claude Terminal"
        worktreeLabel="feat/term"
        modeIconKey="claude"
        channel="pty"
      />,
    );

    expect(container.querySelector(".mode-icon--terminal")).not.toBeNull();
  });
});
