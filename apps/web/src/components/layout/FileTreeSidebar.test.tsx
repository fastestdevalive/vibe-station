import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockApi } from "@/api/mock";
import { FileTreeSidebar } from "./FileTreeSidebar";
import { useWorkspaceStore } from "@/hooks/useStore";

describe("FileTreeSidebar", () => {
  const api = createMockApi();

  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeSessionId: "sess-main",
      showDotFiles: true,
    });
  });

  it("renders top-level entries from mock api", async () => {
    render(<FileTreeSidebar api={api} />);
    await waitFor(() => {
      expect(screen.getByText("README.md")).toBeInTheDocument();
    });
  });

  it("folder chevron triggers api.tree for path", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "tree");
    render(<FileTreeSidebar api={api} />);
    await screen.findByText("src");
    const expand = screen.getByRole("button", { name: /Expand folder/i });
    await user.click(expand);
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith("sess-main", "src");
    });
  });

  it("clicking file sets active file path", async () => {
    const user = userEvent.setup();
    render(<FileTreeSidebar api={api} />);
    await screen.findByText("README.md");
    await user.click(screen.getByText("README.md"));
    expect(useWorkspaceStore.getState().activeFilePath).toBe("README.md");
  });

  it("dotfiles toggle hides dotfiles when off", async () => {
    const user = userEvent.setup();
    render(<FileTreeSidebar api={api} />);
    await screen.findByText(".env.local");
    const cb = screen.getByRole("checkbox", { name: /dots/i });
    await user.click(cb);
    expect(screen.queryByText(".env.local")).toBeNull();
  });
});
