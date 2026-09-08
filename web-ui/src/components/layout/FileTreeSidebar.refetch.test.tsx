import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockApi } from "@/api/mock";
import { FileTreeSidebar } from "./FileTreeSidebar";
import { useWorkspaceStore } from "@/hooks/useStore";
import type { TreeEntry } from "@/api/types";

/**
 * Regression for the refetch-amplification bug: the hoisted children-loading
 * effect (Phase 8) must only fetch children for directories that are
 * expanded AND missing from `childrenByPath` — expanding a second directory
 * must not re-fetch the first, already-loaded one.
 */
describe("FileTreeSidebar — children-loading effect does not amplify refetches", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeSessionId: "sess-main",
      showDotFiles: true,
    });
  });

  it("expanding a second directory does not re-fetch the first, already-expanded directory", async () => {
    const api = createMockApi();
    const tree = vi.spyOn(api, "tree").mockImplementation(async (_wtId, path: string): Promise<TreeEntry[]> => {
      if (path === "") {
        return [
          { name: "dirA", path: "dirA", type: "dir" },
          { name: "dirB", path: "dirB", type: "dir" },
        ];
      }
      if (path === "dirA") return [{ name: "a.ts", path: "dirA/a.ts", type: "file" }];
      if (path === "dirB") return [{ name: "b.ts", path: "dirB/b.ts", type: "file" }];
      return [];
    });

    const user = userEvent.setup();
    render(<FileTreeSidebar api={api} />);

    await screen.findByText("dirA");
    await screen.findByText("dirB");

    await user.click(screen.getByRole("treeitem", { name: "dirA" }));
    await screen.findByText("a.ts");

    const callsAfterFirstExpand = tree.mock.calls.filter((c) => c[1] === "dirA").length;
    expect(callsAfterFirstExpand).toBe(1);
    tree.mockClear();

    await user.click(screen.getByRole("treeitem", { name: "dirB" }));
    await screen.findByText("b.ts");

    // Expanding dirB must fetch dirB only — not re-fetch dirA, which is
    // already expanded and already has its children loaded.
    await waitFor(() => expect(tree.mock.calls.some((c) => c[1] === "dirB")).toBe(true));
    expect(tree.mock.calls.some((c) => c[1] === "dirA")).toBe(false);

    tree.mockRestore();
  });
});
