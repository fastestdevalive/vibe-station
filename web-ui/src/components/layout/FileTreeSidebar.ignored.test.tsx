import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockApi } from "@/api/mock";
import { FileTreeSidebar } from "./FileTreeSidebar";
import { useWorkspaceStore } from "@/hooks/useStore";
import type { TreeEntry } from "@/api/types";

describe("FileTreeSidebar — gitignored entries listed by the daemon", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ activeWorktreeId: "wt-1", activeSessionId: "sess-main", showDotFiles: true });
  });

  it("marks ignored rows (dimmed, tooltip) and leaves normal rows alone", async () => {
    const api = createMockApi();
    vi.spyOn(api, "tree").mockImplementation(async (): Promise<TreeEntry[]> => [
      { name: "dist", path: "dist", type: "dir", ignored: true },
      { name: "logo.png", path: "logo.png", type: "file", ignored: true },
      { name: "src", path: "src", type: "dir" },
    ]);
    render(<FileTreeSidebar api={api} />);
    const dist = await screen.findByRole("treeitem", { name: /dist/ });
    expect(dist.className).toContain("tree-row--ignored");
    expect(dist.getAttribute("title")).toBe("Ignored by .gitignore");
    expect((await screen.findByRole("treeitem", { name: /logo\.png/ })).className).toContain("tree-row--ignored");
    const src = screen.getByRole("treeitem", { name: /src/ });
    expect(src.className).not.toContain("tree-row--ignored");
    expect(src.getAttribute("title")).toBeNull();
  });

  it("expanding an ignored dir fetches its children once", async () => {
    const api = createMockApi();
    const tree = vi.spyOn(api, "tree").mockImplementation(async (_wt, path: string): Promise<TreeEntry[]> => {
      if (path === "") return [{ name: "dist", path: "dist", type: "dir", ignored: true }];
      if (path === "dist") return [{ name: "bundle.js", path: "dist/bundle.js", type: "file", ignored: true }];
      return [];
    });
    const user = userEvent.setup();
    render(<FileTreeSidebar api={api} />);
    await user.click(await screen.findByRole("treeitem", { name: /dist/ }));
    await screen.findByText("bundle.js");
    expect(tree.mock.calls.filter((c) => c[1] === "dist").length).toBe(1);
  });

  it("collapsing then re-expanding an ignored dir refetches its listing", async () => {
    const api = createMockApi();
    let contents = ["old.js"];
    const tree = vi.spyOn(api, "tree").mockImplementation(async (_wt, path: string): Promise<TreeEntry[]> => {
      if (path === "") return [{ name: "dist", path: "dist", type: "dir", ignored: true }];
      if (path === "dist") return contents.map((n) => ({ name: n, path: `dist/${n}`, type: "file" as const, ignored: true }));
      return [];
    });
    const user = userEvent.setup();
    render(<FileTreeSidebar api={api} />);
    const dist = await screen.findByRole("treeitem", { name: /dist/ });
    await user.click(dist);
    await screen.findByText("old.js");
    await user.click(screen.getByRole("treeitem", { name: /dist/ })); // collapse
    contents = ["new.js"]; // a build rewrote the (watch-pruned) ignored dir
    await user.click(screen.getByRole("treeitem", { name: /dist/ })); // re-expand
    await screen.findByText("new.js");
    expect(tree.mock.calls.filter((c) => c[1] === "dist").length).toBe(2);
  });
});
