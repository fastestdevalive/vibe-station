import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { BulkMenu } from "./BulkMenu";
import { useBulkWorktrees } from "./useBulkWorktrees";

function renderMenu() {
  return render(
    <MemoryRouter>
      <BulkMenu />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useBulkWorktrees.setState({ mode: null, selected: new Set(), job: null });
});

describe("BulkMenu", () => {
  it("opens a menu listing the two bulk actions", async () => {
    const user = userEvent.setup();
    renderMenu();

    expect(screen.queryByRole("menu", { name: /bulk actions/i })).toBeNull();
    await user.click(screen.getByRole("button", { name: /bulk actions/i }));

    expect(screen.getByRole("menu", { name: /bulk actions/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /archive worktrees/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /delete worktrees/i })).toBeInTheDocument();
  });

  it("choosing Delete worktrees… enters delete select mode", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole("button", { name: /bulk actions/i }));
    await user.click(screen.getByRole("menuitem", { name: /delete worktrees/i }));

    expect(useBulkWorktrees.getState().mode).toBe("delete");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("choosing Archive worktrees… enters archive select mode", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole("button", { name: /bulk actions/i }));
    await user.click(screen.getByRole("menuitem", { name: /archive worktrees/i }));

    expect(useBulkWorktrees.getState().mode).toBe("archive");
  });

  it("disables both items while a bulk job is unfinished", async () => {
    useBulkWorktrees.setState({
      job: {
        id: 1,
        action: "delete",
        items: [{ id: "wt-1", label: "wt-1", status: "running" }],
        finished: false,
        cancelRequested: false,
      },
    });
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole("button", { name: /bulk actions/i }));

    const archive = screen.getByRole("menuitem", { name: /archive worktrees/i });
    const del = screen.getByRole("menuitem", { name: /delete worktrees/i });
    expect(archive).toBeDisabled();
    expect(del).toBeDisabled();
    expect(del).toHaveAttribute("title", "A bulk action is running");
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole("button", { name: /bulk actions/i }));
    await screen.findByRole("menu", { name: /bulk actions/i });
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu", { name: /bulk actions/i })).toBeNull();
  });
});
