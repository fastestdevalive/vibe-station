import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { ApiError, ArtifactReadError } from "@/api/errors";
import type { ApiInstance } from "@/api";
import type { ArtifactRow, WSEvent } from "@/api/types";
import { useOpenFilesChanged } from "@/hooks/usePendingFileOpens";
import { FilePreviewPane } from "./FilePreviewPane";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useServerStore } from "@/hooks/useServerStore";
import { useArtifactsStore } from "@/components/artifacts/artifactsStore";
import { makeRow } from "@/components/artifacts/testFixtures";
import { HTML_IFRAME_SANDBOX } from "@/components/preview/htmlDocument";
import * as lspApi from "@/lib/lspApi";

const WT = "wt-1";
const OUT = "/home/u/.claude/plans/plan.md";

function outsideRow(over: Partial<ArtifactRow> = {}): ArtifactRow {
  return makeRow({
    id: "a1",
    scopeId: WT,
    path: OUT,
    displayPath: "~/.claude/plans/plan.md",
    inRepo: false,
    ...over,
  });
}

function seed(rows: ArtifactRow[], status: "ready" | "loading" = "ready") {
  const store = useArtifactsStore.getState();
  if (status === "loading") store.setLoading(WT, "worktree");
  else store.replace(WT, "worktree", { rev: 1, cap: 500, total: rows.length, items: rows });
}

function openTab(path: string) {
  useWorkspaceStore.setState({
    activeWorktreeId: WT,
    activeFilePath: path,
    openFileTabsByWorktree: { [WT]: [path] },
    activeFileTabIdxByWorktree: { [WT]: 0 },
    diffScopeByWorktree: {},
    peekFile: null,
  });
}

/** Spy on every worktree-relative read so a test can assert an artifact path never touches them. */
function spyRepoPipeline(api: ReturnType<typeof createMockApi>) {
  return {
    getFile: vi.spyOn(api, "getFile"),
    getDiff: vi.spyOn(api, "getDiff"),
    getGutter: vi.spyOn(api, "getGutter"),
    getFileBlob: vi.spyOn(api, "getFileBlob"),
    send: vi.spyOn(api, "send"),
  };
}

beforeEach(() => {
  useArtifactsStore.getState().reset();
  useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: true });
});
afterEach(() => vi.restoreAllMocks());

describe("FilePreviewPane artifact branch (8.T4)", () => {
  it("an outside-repo path with a row fetches getArtifactContent and never uses the repo pipeline or watchers", async () => {
    const api = createMockApi();
    const spies = spyRepoPipeline(api);
    const content = vi.spyOn(api, "getArtifactContent").mockResolvedValue({ kind: "text", body: "# Outside plan\n\nhello" });
    seed([outsideRow()]);
    openTab(OUT);
    render(<FilePreviewPane api={api} worktreeId={WT} />);

    expect(await screen.findByRole("heading", { name: "Outside plan" })).toBeInTheDocument();
    expect(content).toHaveBeenCalledWith("a1");
    expect(spies.getFile).not.toHaveBeenCalled();
    expect(spies.getDiff).not.toHaveBeenCalled();
    expect(spies.getGutter).not.toHaveBeenCalled();
    expect(spies.getFileBlob).not.toHaveBeenCalled();
    const watchSends = spies.send.mock.calls.filter(([m]) => m.type === "file:watch" || m.type === "tree:watch");
    expect(watchSends).toEqual([]);
  });

  it("an outside artifact ignores the diff scope: no gutter poll even while the 2 s poll would tick", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = createMockApi();
      const getGutter = vi.spyOn(api, "getGutter");
      vi.spyOn(api, "getArtifactContent").mockResolvedValue({ kind: "text", body: "plain" });
      seed([outsideRow()]);
      openTab(OUT);
      useWorkspaceStore.setState({ diffScopeByWorktree: { [WT]: "local" } });
      render(<FilePreviewPane api={api} worktreeId={WT} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(getGutter).not.toHaveBeenCalled();
      expect(screen.queryByText("Compared to HEAD")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed artifacts list shows an error state with Retry that refetches (review 15)", async () => {
    const api = createMockApi();
    const list = vi
      .spyOn(api, "listArtifacts")
      .mockRejectedValueOnce(new Error("daemon down"))
      .mockResolvedValue({ rev: 1, cap: 500, total: 1, items: [outsideRow()] });
    vi.spyOn(api, "getArtifactContent").mockResolvedValue({ kind: "text", body: "# Back\n" });
    openTab(OUT);
    render(<FilePreviewPane api={api} worktreeId={WT} />);

    expect(await screen.findByText("Couldn’t load artifacts")).toBeInTheDocument();
    expect(screen.getByText("daemon down")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Back" })).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("an absolute path with no row (store ready) shows 'No longer an artifact' and Close tab closes it", async () => {
    const api = createMockApi();
    const getContent = vi.spyOn(api, "getArtifactContent");
    seed([]);
    openTab(OUT);
    render(<FilePreviewPane api={api} worktreeId={WT} />);

    expect(await screen.findByText("No longer an artifact")).toBeInTheDocument();
    expect(screen.getByText(/dropped from the list/)).toBeInTheDocument();
    expect(getContent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    expect(useWorkspaceStore.getState().openFileTabsByWorktree[WT]).toEqual([]);
  });

  it("while the artifacts store is not ready the tab shows loading, never 'No longer an artifact'", () => {
    const api = createMockApi();
    vi.spyOn(api, "listArtifacts").mockImplementation(() => new Promise(() => {}));
    seed([], "loading");
    openTab(OUT);
    render(<FilePreviewPane api={api} worktreeId={WT} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("No longer an artifact")).not.toBeInTheDocument();
  });

  it("an artifact:upserted that removes the row flips the open tab to 'No longer an artifact' live", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getArtifactContent").mockResolvedValue({ kind: "text", body: "# T" });
    seed([outsideRow()]);
    openTab(OUT);
    render(<FilePreviewPane api={api} worktreeId={WT} />);
    await screen.findByRole("heading", { name: "T" });
    act(() => useArtifactsStore.getState().applyRemoved({ scopeId: WT, rev: 2, ids: ["a1"], reason: "cap" }));
    expect(await screen.findByText("No longer an artifact")).toBeInTheDocument();
  });

  it("a truncated text artifact shows the warn banner with the full size and a Copy path button", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getArtifactContent").mockResolvedValue({ kind: "text", body: "# Big\n", truncatedTotal: 14_000_000 });
    seed([outsideRow()]);
    openTab(OUT);
    render(<FilePreviewPane api={api} worktreeId={WT} />);
    expect(await screen.findByText("Showing the first 1 MB of 14 MB")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy path" })).toBeInTheDocument();
  });

  it.each([
    ["ARTIFACT_UNREADABLE", 403, { detail: "EACCES" }, ["Can’t read this file", "Permission denied (EACCES)."]],
    ["ARTIFACT_BINARY", 415, { size: 3_200_000, mime: "application/zip" }, ["Binary file", "No preview. 3.2 MB · application/zip"]],
    ["ARTIFACT_TOO_LARGE", 422, { size: 20_000_000 }, ["Too large to preview", "20 MB"]],
    ["ARTIFACT_MISSING", 410, {}, ["File not found", "This file was deleted or moved."]],
  ] as const)("%s renders its state panel with Copy path", async (code, status, info, [title, body]) => {
    const api = createMockApi();
    vi.spyOn(api, "getArtifactContent").mockRejectedValue(new ArtifactReadError("x", status, code, { ...info }));
    seed([outsideRow()]);
    openTab(OUT);
    render(<FilePreviewPane api={api} worktreeId={WT} />);
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.getByText(body)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy path" })).toBeInTheDocument();
  });

  it("a missing HTML artifact shows File not found without the Rendered/Source toggle", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getArtifactContent").mockRejectedValue(new ArtifactReadError("gone", 410, "ARTIFACT_MISSING"));
    const htmlPath = "/tmp/vibe/page.html";
    seed([outsideRow({ path: htmlPath, displayPath: "/tmp/vibe/page.html", state: "missing" })]);
    openTab(htmlPath);
    render(<FilePreviewPane api={api} worktreeId={WT} />);
    expect(await screen.findByText("File not found")).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Rendered/ })).toBeNull();
    expect(screen.queryByRole("radio", { name: /Source/ })).toBeNull();
    expect(screen.queryByText("Rendered")).toBeNull();
    expect(screen.queryByText("Source")).toBeNull();
  });

  it("a missing row offers Remove, which removes the artifact and falls through to 'No longer an artifact'", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getArtifactContent").mockRejectedValue(new ArtifactReadError("gone", 410, "ARTIFACT_MISSING"));
    const remove = vi.spyOn(api, "removeArtifact").mockResolvedValue({ ok: true });
    seed([outsideRow({ state: "missing" })]);
    openTab(OUT);
    render(<FilePreviewPane api={api} worktreeId={WT} />);
    expect(await screen.findByText("File not found")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("a1"));
    expect(await screen.findByText("No longer an artifact")).toBeInTheDocument();
  });

  it("a failed Remove (500) says so and keeps the panel; the row is not hidden", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getArtifactContent").mockRejectedValue(new ArtifactReadError("gone", 410, "ARTIFACT_MISSING"));
    vi.spyOn(api, "removeArtifact").mockRejectedValue(new ApiError("boom", 500));
    seed([outsideRow({ state: "missing" })]);
    openTab(OUT);
    render(<FilePreviewPane api={api} worktreeId={WT} />);
    await screen.findByText("File not found");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Couldn’t remove this artifact")).toBeInTheDocument();
    expect(screen.getByText("File not found")).toBeInTheDocument();
  });

  it("a row flipped to missing by artifact:upserted swaps the panel in without a refetch round-trip", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getArtifactContent").mockResolvedValue({ kind: "text", body: "# Here" });
    seed([outsideRow()]);
    openTab(OUT);
    render(<FilePreviewPane api={api} worktreeId={WT} />);
    await screen.findByRole("heading", { name: "Here" });
    vi.spyOn(api, "getArtifactContent").mockRejectedValue(new ArtifactReadError("gone", 410, "ARTIFACT_MISSING"));
    act(() => {
      useArtifactsStore.getState().applyUpserted({ scopeId: WT, rev: 2, rows: [{ ...outsideRow({ state: "missing" }), created: false }] });
    });
    expect(screen.getByText("File not found")).toBeInTheDocument();
  });

  it("an artifact:upserted with a newer lastWrittenAt refetches the content without a Loading flash", async () => {
    const api = createMockApi();
    let release!: (v: { kind: "text"; body: string }) => void;
    const content = vi
      .spyOn(api, "getArtifactContent")
      .mockResolvedValueOnce({ kind: "text", body: "# Version one" })
      .mockImplementationOnce(() => new Promise((res) => (release = res)));
    seed([outsideRow()]);
    openTab(OUT);
    render(<FilePreviewPane api={api} worktreeId={WT} />);
    await screen.findByRole("heading", { name: "Version one" });

    act(() => {
      useArtifactsStore
        .getState()
        .applyUpserted({ scopeId: WT, rev: 2, rows: [{ ...outsideRow({ lastWrittenAt: "2026-10-27T11:00:00.000Z" }), created: false }] });
    });
    await waitFor(() => expect(content).toHaveBeenCalledTimes(2));
    // The refetch is in flight: the old body stays, no Loading placeholder.
    expect(screen.getByRole("heading", { name: "Version one" })).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    await act(async () => release({ kind: "text", body: "# Version two" }));
    expect(await screen.findByRole("heading", { name: "Version two" })).toBeInTheDocument();
  });

  it("a pin toggle (same lastWrittenAt/size) does not refetch the content", async () => {
    const api = createMockApi();
    const content = vi.spyOn(api, "getArtifactContent").mockResolvedValue({ kind: "text", body: "# Pinned" });
    seed([outsideRow()]);
    openTab(OUT);
    render(<FilePreviewPane api={api} worktreeId={WT} />);
    await screen.findByRole("heading", { name: "Pinned" });
    act(() => {
      useArtifactsStore.getState().applyUpserted({ scopeId: WT, rev: 2, rows: [{ ...outsideRow({ pinned: true }), created: false }] });
    });
    expect(screen.getByRole("button", { name: "Unpin" })).toHaveAttribute("aria-pressed", "true");
    expect(content).toHaveBeenCalledTimes(1);
  });

  it("an LSP external peek with an ABSOLUTE path renders through its token, not 'No longer an artifact'", async () => {
    const api = createMockApi();
    const ext = vi.spyOn(lspApi, "getExternalFile").mockResolvedValue("export const x = 1;\n");
    const getContent = vi.spyOn(api, "getArtifactContent");
    seed([]);
    useWorkspaceStore.setState({
      activeWorktreeId: WT,
      activeFilePath: null,
      diffScopeByWorktree: {},
      peekFile: {
        worktreeId: WT,
        path: "/usr/lib/node_modules/x/index.ts",
        line: 1,
        matchText: null,
        source: "definition",
        external: { token: "tok-1", displayPath: "x/index.ts" },
      },
    });
    const { container } = render(<FilePreviewPane api={api} worktreeId={WT} />);
    await waitFor(() => expect(container.querySelector(".workspace-code-viewer")).toBeTruthy());
    expect(ext).toHaveBeenCalledWith(api, "worktree", WT, "tok-1");
    expect(screen.queryByText("No longer an artifact")).not.toBeInTheDocument();
    expect(getContent).not.toHaveBeenCalled();
  });

  it("an in-repo artifact (relative path) keeps the gutter and diff pipeline and shows the strip pin", async () => {
    const api = createMockApi();
    const getGutter = vi.spyOn(api, "getGutter");
    const getArtifactContent = vi.spyOn(api, "getArtifactContent");
    seed([makeRow({ id: "in1", scopeId: WT, path: "/repo/README.md", displayPath: "README.md", inRepo: true })]);
    openTab("README.md");
    render(<FilePreviewPane api={api} worktreeId={WT} />);
    await screen.findByRole("heading", { name: "Demo" });
    await waitFor(() => expect(getGutter).toHaveBeenCalled());
    expect(getArtifactContent).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Diff line counts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pin" })).toBeInTheDocument();
    // No outside-repo chip for an in-repo row.
    expect(screen.queryByText("outside repo")).not.toBeInTheDocument();
  });

  it("an image artifact renders through getArtifactContent (blob), not getFileBlob", async () => {
    const api = createMockApi();
    const spies = spyRepoPipeline(api);
    const content = vi
      .spyOn(api, "getArtifactContent")
      .mockResolvedValue({ kind: "image", blob: new Blob(["x"], { type: "image/png" }) });
    seed([outsideRow({ id: "img", path: "/tmp/shots/login.png", displayPath: "/tmp/shots/login.png", kind: "image" })]);
    openTab("/tmp/shots/login.png");
    const { container } = render(<FilePreviewPane api={api} worktreeId={WT} />);
    await waitFor(() => expect(container.querySelector("img.preview-image, .zoomable-media img")).toBeTruthy());
    expect(content).toHaveBeenCalledWith("img");
    expect(spies.getFileBlob).not.toHaveBeenCalled();
  });

  it("an image artifact too large for preview shows the Too large panel", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getArtifactContent").mockRejectedValue(new ArtifactReadError("big", 422, "ARTIFACT_TOO_LARGE", { size: 12_000_000 }));
    seed([outsideRow({ id: "img", path: "/tmp/big.png", displayPath: "/tmp/big.png", kind: "image" })]);
    openTab("/tmp/big.png");
    render(<FilePreviewPane api={api} worktreeId={WT} />);
    expect(await screen.findByText("Too large to preview")).toBeInTheDocument();
    expect(screen.getByText("12 MB")).toBeInTheDocument();
  });

  it("the strip shows the display path, writer chip, outside repo chip and a working pin toggle", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getArtifactContent").mockResolvedValue({ kind: "text", body: "# P" });
    const pin = vi.spyOn(api, "pinArtifact").mockResolvedValue(outsideRow({ pinned: true }));
    useServerStore.setState({
      sessions: [
        {
          id: "s1",
          worktreeId: WT,
          projectId: "p1",
          modeId: null,
          type: "agent",
          name: "main",
          isMain: true,
          state: "working",
          lifecycleState: "drafting",
          tmuxName: "s1",
          createdAt: "2026-10-27T09:00:00.000Z",
        },
      ],
    });
    seed([outsideRow({ writers: ["s1"] })]);
    openTab(OUT);
    render(<FilePreviewPane api={api} worktreeId={WT} />);
    await screen.findByRole("heading", { name: "P" });
    expect(screen.getByTitle(OUT)).toHaveTextContent("~/.claude/plans/plan.md");
    expect(screen.getByText("outside repo")).toBeInTheDocument();
    expect(screen.getByTitle("Written by main")).toBeInTheDocument();
    // The board's strip has no Copy path button.
    expect(screen.queryByRole("button", { name: "Copy path" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(pin).toHaveBeenCalledWith("a1", true));
    await waitFor(() => expect(screen.getByRole("button", { name: "Unpin" })).toHaveAttribute("aria-pressed", "true"));
  });

  it("R1F-01: the root reserves the font overlay's width and still contains the pin", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getArtifactContent").mockResolvedValue({ kind: "text", body: "# P" });
    seed([outsideRow()]);
    openTab(OUT);
    const { container } = render(<FilePreviewPane api={api} worktreeId={WT} />);
    await screen.findByRole("heading", { name: "P" });
    const root = container.querySelector(".preview-pane")!;
    expect(root).toHaveClass("preview-pane--font-overlay");
    expect(root.querySelector(".artifact-strip__pin")).toBeTruthy();
    // R1F-01 (round 1): the font controls are the strip's last in-flow child, not an absolute sibling.
    const strip = root.querySelector(".preview-diffinfo.artifact-strip")!;
    expect(strip.lastElementChild).toHaveClass("preview-font-overlay");
  });

  it("a PIN_LIMIT failure from the strip pin shows the limit notice", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getArtifactContent").mockResolvedValue({ kind: "text", body: "# P" });
    vi.spyOn(api, "pinArtifact").mockRejectedValue(new ArtifactReadError("limit", 409, "PIN_LIMIT"));
    seed([outsideRow()]);
    openTab(OUT);
    render(<FilePreviewPane api={api} worktreeId={WT} />);
    await screen.findByRole("heading", { name: "P" });
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    expect(await screen.findByText("50 pinned is the limit")).toBeInTheDocument();
  });

  it("the tab and its preview survive an openFiles:changed echo that carries the absolute path", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getArtifactContent").mockResolvedValue({ kind: "text", body: "# Persisted" });
    seed([outsideRow()]);
    openTab(OUT);
    let echo: ((ev: WSEvent) => void) | null = null;
    const echoApi = {
      ...api,
      on: (event: string, cb: (ev: WSEvent) => void) => {
        if (event === "openFiles:changed") echo = cb;
        return () => {};
      },
    } as unknown as ApiInstance;
    renderHook(() => useOpenFilesChanged(echoApi));
    render(<FilePreviewPane api={api} worktreeId={WT} />);
    await screen.findByRole("heading", { name: "Persisted" });
    // The daemon persists the absolute path verbatim (4.4b), so its echo replaces the local list with it.
    act(() => echo!({ type: "openFiles:changed", worktreeId: WT, paths: ["docs/a.md", OUT] } as WSEvent));
    expect(useWorkspaceStore.getState().openFileTabsByWorktree[WT]).toEqual(["docs/a.md", OUT]);
    expect(screen.getByRole("heading", { name: "Persisted" })).toBeInTheDocument();
  });
});

describe("HTML artifacts (8.T5)", () => {
  const HTML_OUT = "/tmp/mockups/rail.html";
  const htmlRow = () => outsideRow({ id: "h1", path: HTML_OUT, displayPath: HTML_OUT });

  beforeEach(() => {
    try {
      window.localStorage.removeItem("vibestation:html-preview-mode");
    } catch {
      /* ignore */
    }
  });

  it("renders only through HtmlView: the iframe sandbox is exactly HTML_IFRAME_SANDBOX", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getArtifactContent").mockResolvedValue({ kind: "text", body: "<h1>Hi</h1>" });
    seed([htmlRow()]);
    openTab(HTML_OUT);
    const { container } = render(<FilePreviewPane api={api} worktreeId={WT} />);
    await waitFor(() => expect(container.querySelector("iframe")).toBeTruthy());
    const frames = container.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.getAttribute("sandbox")).toBe(HTML_IFRAME_SANDBOX);
    expect(frames[0]!.getAttribute("allow")).toBeNull();
    expect(frames[0]!.getAttribute("src")).toBeNull();
    expect(screen.getByRole("group", { name: "HTML view mode" })).toBeInTheDocument();
  });

  it("R1F-01: Rendered mode hides the font overlay and omits the reserve class", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getArtifactContent").mockResolvedValue({ kind: "text", body: "<h1>Hi</h1>" });
    seed([htmlRow()]);
    openTab(HTML_OUT);
    const { container } = render(<FilePreviewPane api={api} worktreeId={WT} />);
    await waitFor(() => expect(container.querySelector("iframe")).toBeTruthy());
    expect(container.querySelector(".preview-pane")).not.toHaveClass("preview-pane--font-overlay");
  });

  it("an over-cap body falls back to Source (no iframe, Rendered disabled)", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getArtifactContent").mockResolvedValue({ kind: "text", body: `<p>${"x".repeat(1024 * 1024 + 10)}</p>` });
    seed([htmlRow()]);
    openTab(HTML_OUT);
    const { container } = render(<FilePreviewPane api={api} worktreeId={WT} />);
    await waitFor(() => expect(container.querySelector(".workspace-code-viewer")).toBeTruthy());
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("a truncated HTML artifact falls back to Source and shows the truncation banner", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getArtifactContent").mockResolvedValue({ kind: "text", body: "<h1>cut", truncatedTotal: 2 * 1024 * 1024 });
    seed([htmlRow()]);
    openTab(HTML_OUT);
    const { container } = render(<FilePreviewPane api={api} worktreeId={WT} />);
    await waitFor(() => expect(container.querySelector(".workspace-code-viewer")).toBeTruthy());
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByText(/Showing the first 1 MB of/)).toBeInTheDocument();
  });
});
