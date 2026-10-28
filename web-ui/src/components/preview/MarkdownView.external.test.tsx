import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { MarkdownView } from "./MarkdownView";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useArtifactsStore } from "@/components/artifacts/artifactsStore";
import { makeRow } from "@/components/artifacts/testFixtures";

const WT = "wt-1";
const FILE = "/home/u/.claude/plans/plan.md";

beforeEach(() => {
  useArtifactsStore.getState().reset();
  useArtifactsStore.getState().replace(WT, "worktree", {
    rev: 1,
    cap: 500,
    total: 4,
    items: [
      makeRow({ id: "sp", scopeId: WT, path: "/home/u/.claude/plans/my plan.md", displayPath: "~/.claude/plans/my plan.md", inRepo: false }),
      makeRow({ id: "fr", scopeId: WT, path: "/home/u/.claude/plans/résumé.md", displayPath: "~/.claude/plans/résumé.md", inRepo: false }),
      makeRow({ id: "sib", scopeId: WT, path: "/home/u/.claude/plans/sibling.md", displayPath: "~/.claude/plans/sibling.md", inRepo: false }),
      makeRow({ id: "rep", scopeId: WT, path: "/repo/docs/guide.md", displayPath: "docs/guide.md", inRepo: true }),
    ],
  });
});
afterEach(() => vi.restoreAllMocks());

describe("MarkdownView external (8.T6)", () => {
  it("a relative image shows the blocked placeholder and fetches nothing", () => {
    const api = createMockApi();
    const blob = vi.spyOn(api, "getFileBlob");
    render(<MarkdownView source="![shot](../../../etc/passwd)" api={api} worktreeId={WT} filePath={FILE} external />);
    expect(screen.getByRole("img", { name: /Image blocked \(outside the repo\)/ })).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(blob).not.toHaveBeenCalled();
  });

  it("an absolute-path image is blocked too, a remote image still renders", () => {
    const api = createMockApi();
    const blob = vi.spyOn(api, "getFileBlob");
    render(
      <MarkdownView
        source={"![a](/etc/passwd)\n\n![b](https://example.com/x.png)"}
        api={api}
        worktreeId={WT}
        filePath={FILE}
        external
      />,
    );
    expect(screen.getAllByText("Image blocked (outside the repo)")).toHaveLength(1);
    expect(document.querySelectorAll("img")).toHaveLength(1);
    expect(document.querySelector("img")).toHaveAttribute("src", "https://example.com/x.png");
    expect(blob).not.toHaveBeenCalled();
  });

  it("without external, relative images still go through the worktree file route (regression)", async () => {
    const api = createMockApi();
    const blob = vi.spyOn(api, "getFileBlob");
    render(<MarkdownView source="![logo](./assets/logo.png)" api={api} worktreeId={WT} filePath="docs/README.md" />);
    await vi.waitFor(() => expect(blob).toHaveBeenCalledWith(WT, "docs/assets/logo.png", "worktree"));
  });

  it("a local-path link that is not an artifact is inert (no anchor, no navigation)", () => {
    render(<MarkdownView source="[secrets](/etc/passwd) and [rel](../../../etc/hosts)" api={null} worktreeId={WT} filePath={FILE} external />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("secrets")).toHaveClass("markdown-link-inert");
    expect(screen.getByText("rel")).toHaveClass("markdown-link-inert");
  });

  it("http(s) and mailto links stay normal links", () => {
    render(<MarkdownView source="[web](https://example.com) [mail](mailto:a@b.co)" api={null} worktreeId={WT} filePath={FILE} external />);
    expect(screen.getByRole("link", { name: "web" })).toHaveAttribute("href", "https://example.com");
    expect(screen.getByRole("link", { name: "mail" })).toHaveAttribute("href", "mailto:a@b.co");
  });

  it("a link resolving to an artifact row opens that row's tab (absolute path outside the repo)", async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(useWorkspaceStore.getState(), "openFileTabNew").mockImplementation(() => {});
    render(<MarkdownView source="[next](./sibling.md)" api={null} worktreeId={WT} filePath={FILE} external />);
    await user.click(screen.getByRole("link", { name: "next" }));
    expect(open).toHaveBeenCalledWith(WT, "/home/u/.claude/plans/sibling.md");
  });

  it("a link resolving to an in-repo artifact opens it by its repo-relative path", async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(useWorkspaceStore.getState(), "openFileTabNew").mockImplementation(() => {});
    render(<MarkdownView source="[guide](/repo/docs/guide.md#top)" api={null} worktreeId={WT} filePath={FILE} external />);
    await user.click(screen.getByRole("link", { name: "guide" }));
    expect(open).toHaveBeenCalledWith(WT, "docs/guide.md");
  });

  it("percent-encoded targets (spaces, non-ASCII) resolve to the artifact row", async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(useWorkspaceStore.getState(), "openFileTabNew").mockImplementation(() => {});
    render(<MarkdownView source={"[n](<my plan.md>) [r](résumé.md)"} api={null} worktreeId={WT} filePath={FILE} external />);
    await user.click(screen.getByRole("link", { name: "n" }));
    expect(open).toHaveBeenCalledWith(WT, "/home/u/.claude/plans/my plan.md");
    await user.click(screen.getByRole("link", { name: "r" }));
    expect(open).toHaveBeenLastCalledWith(WT, "/home/u/.claude/plans/résumé.md");
  });

  it("without external, links render as before (no inert rewrite)", () => {
    render(<MarkdownView source="[local](./other.md)" api={null} worktreeId={WT} filePath="docs/a.md" />);
    expect(screen.getByRole("link", { name: "local" })).toHaveAttribute("href", "./other.md");
  });
});
