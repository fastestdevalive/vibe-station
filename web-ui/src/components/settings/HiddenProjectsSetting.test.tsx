import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Project } from "@/api/types";
import { createMockApi } from "@/api/mock";
import { HiddenProjectsSetting } from "./HiddenProjectsSetting";
import { useServerStore } from "@/hooks/useServerStore";

function proj(id: string, name: string, hidden: boolean): Project {
  return {
    id,
    name,
    path: `/home/dev/${id}`,
    prefix: id.slice(0, 2),
    defaultBranch: "main",
    createdAt: "2024-01-01T00:00:00.000Z",
    hidden,
  };
}

describe("HiddenProjectsSetting", () => {
  beforeEach(() => {
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: true });
  });

  it("shows an empty state when no projects are hidden", () => {
    useServerStore.setState({ projects: [proj("a", "Alpha", false)] });
    render(<HiddenProjectsSetting api={createMockApi()} />);
    expect(screen.getByText(/no hidden projects/i)).toBeInTheDocument();
  });

  it("lists hidden projects and not visible ones", () => {
    useServerStore.setState({
      projects: [proj("a", "Alpha", false), proj("b", "Beta", true)],
    });
    render(<HiddenProjectsSetting api={createMockApi()} />);
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.queryByText("Alpha")).toBeNull();
  });

  it("clicking Unhide calls api.unhideProject", async () => {
    const user = userEvent.setup();
    useServerStore.setState({ projects: [proj("b", "Beta", true)] });
    const api = createMockApi();
    const spy = vi.spyOn(api, "unhideProject").mockResolvedValue({
      ok: true,
      project: proj("b", "Beta", false),
    });
    render(<HiddenProjectsSetting api={api} />);
    await user.click(screen.getByRole("button", { name: /Unhide project Beta/i }));
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith("b");
    });
  });
});
