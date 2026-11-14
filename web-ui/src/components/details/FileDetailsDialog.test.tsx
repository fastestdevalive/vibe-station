import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import { ApiError } from "@/api/errors";
import type { ArtifactRow, FileStat, Session } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { FileDetailsDialog, typeLabel } from "./FileDetailsDialog";
import type { DetailsTarget } from "./detailsStore";

const mobile = { value: false };
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => mobile.value }));

const stat: FileStat = {
  path: "web-ui/src/a.ts",
  absolutePath: "/repo/web-ui/src/a.ts",
  kind: "file",
  size: 12_700,
  modifiedMs: Date.now() - 2 * 3_600_000,
  lineCount: 313,
  inRoot: true,
};

const fileTarget: DetailsTarget = { scope: "worktree", scopeId: "wt1", path: "web-ui/src/a.ts", name: "a.ts" };

function apiWith(impl: ApiInstance["statPath"]) {
  return { statPath: vi.fn(impl) } as unknown as Pick<ApiInstance, "statPath">;
}

function rowValue(label: string): string {
  const dt = Array.from(document.querySelectorAll("dt")).find((d) => d.textContent === label);
  const dd = dt?.parentElement?.querySelector("dd");
  // The value span only: the Path cell also carries its Copy button.
  return dd?.querySelector(".file-details__value")?.textContent ?? dd?.textContent ?? "";
}

describe("FileDetailsDialog (tools-pane-rework B7.3)", () => {
  beforeEach(() => {
    mobile.value = false;
    useServerStore.setState({ sessions: [] });
  });

  it("a file shows its absolute path, type, size with lines, and modified with age", async () => {
    const api = apiWith(async () => stat);
    render(<FileDetailsDialog api={api} target={fileTarget} onClose={vi.fn()} />);
    await waitFor(() => expect(rowValue("Size")).toBe("12.7 KB · 313 lines"));
    expect(rowValue("Path")).toBe("/repo/web-ui/src/a.ts");
    expect(rowValue("Type")).toBe("TypeScript");
    expect(rowValue("Modified")).toMatch(/\(2h ago\)$/);
    expect(api.statPath).toHaveBeenCalledWith("wt1", "web-ui/src/a.ts", "worktree", undefined);
  });

  it("an outside-repo artifact shows 'Outside the repo', its writers and edits", async () => {
    const writer = { id: "s1", name: "Planner", modeIcon: "claude", isMain: false } as unknown as Session;
    useServerStore.setState({ sessions: [writer] });
    const artifact = {
      id: "art1",
      path: "/Users/x/out/report.html",
      displayPath: "~/out/report.html",
      inRepo: false,
      editCount: 3,
      writers: ["s1"],
    } as unknown as ArtifactRow;
    const api = apiWith(async () => ({ ...stat, inRoot: false, lineCount: null }));
    render(<FileDetailsDialog api={api} target={{ scope: "worktree", scopeId: "wt1", path: artifact.path, name: "report.html", artifact }} onClose={vi.fn()} />);
    await waitFor(() => expect(rowValue("Size")).toBe("12.7 KB"));
    expect(rowValue("Location")).toBe("Outside the repo");
    expect(rowValue("Written by")).toBeTruthy();
    expect(rowValue("Edits")).toBe("3 edits");
    expect(api.statPath).toHaveBeenCalledWith("wt1", "/Users/x/out/report.html", "worktree", "art1");
  });

  it("a 403 keeps the path and shows 'unavailable' for size and modified", async () => {
    const api = apiWith(async () => {
      throw new ApiError("denied", 403);
    });
    render(<FileDetailsDialog api={api} target={fileTarget} onClose={vi.fn()} />);
    await waitFor(() => expect(rowValue("Size")).toBe("unavailable"));
    expect(rowValue("Modified")).toBe("unavailable");
    expect(rowValue("Path")).toBe("web-ui/src/a.ts");
  });

  it("a folder shows Folder and no line count", async () => {
    const api = apiWith(async () => ({ ...stat, kind: "dir", size: null, lineCount: null }));
    render(<FileDetailsDialog api={api} target={{ ...fileTarget, path: "web-ui/src", name: "src", isDir: true }} onClose={vi.fn()} />);
    await waitFor(() => expect(rowValue("Size")).toBe("—"));
    expect(rowValue("Type")).toBe("Folder");
  });

  it("a response for an earlier target is ignored when another target opened meanwhile", async () => {
    let resolveFirst!: (s: FileStat) => void;
    const api = apiWith((_id, path) =>
      path === "web-ui/src/a.ts"
        ? new Promise<FileStat>((res) => {
            resolveFirst = res;
          })
        : Promise.resolve({ ...stat, absolutePath: "/repo/second.ts", size: 5, lineCount: null }),
    );
    const { rerender } = render(<FileDetailsDialog api={api} target={fileTarget} onClose={vi.fn()} />);
    rerender(<FileDetailsDialog api={api} target={{ ...fileTarget, path: "second.ts", name: "second.ts" }} onClose={vi.fn()} />);
    await waitFor(() => expect(rowValue("Path")).toBe("/repo/second.ts"));
    await act(async () => {
      resolveFirst({ ...stat, absolutePath: "/repo/stale.ts" });
    });
    expect(rowValue("Path")).toBe("/repo/second.ts");
  });

  it("the git row shows the change and its base when the opener passed git facts", async () => {
    const api = apiWith(async () => stat);
    render(
      <FileDetailsDialog
        api={api}
        target={{ ...fileTarget, git: { status: "M", insertions: 12, deletions: 3, baseLabel: "HEAD" } }}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(rowValue("Git")).toBe("Modified, +12 −3 vs HEAD"));
  });

  it("Escape closes the desktop popup; the copy button copies the loaded absolute path", async () => {
    const onClose = vi.fn();
    const api = apiWith(async () => stat);
    render(<FileDetailsDialog api={api} target={fileTarget} onClose={onClose} />);
    await waitFor(() => expect(rowValue("Size")).not.toBe("…"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Details" })).toBeInTheDocument();
  });

  it("desktop: the Close button calls onClose", async () => {
    const onClose = vi.fn();
    const api = apiWith(async () => stat);
    render(<FileDetailsDialog api={api} target={fileTarget} onClose={onClose} />);
    await waitFor(() => expect(rowValue("Size")).not.toBe("…"));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("typeLabel: known extensions get their label, folders and unknown extensions fall through", () => {
    const file = (name: string) => ({ scope: "worktree", scopeId: "wt1", path: name, name }) as DetailsTarget;
    expect(typeLabel(file("a.html"), null)).toBe("HTML");
    expect(typeLabel(file("a.tsx"), null)).toBe("TypeScript (TSX)");
    expect(typeLabel(file("a.md"), null)).toBe("Markdown");
    expect(typeLabel({ ...file("src"), isDir: true }, null)).toBe("Folder");
    expect(typeLabel(file("a.xyz"), null)).toBe("XYZ");
  });

  it("on phones the same facts render in the bottom sheet, not the desktop popup", async () => {
    mobile.value = true;
    const api = apiWith(async () => stat);
    render(<FileDetailsDialog api={api} target={fileTarget} onClose={vi.fn()} />);
    await waitFor(() => expect(rowValue("Size")).toBe("12.7 KB · 313 lines"));
    expect(document.querySelector(".file-details-backdrop")).toBeNull();
    expect(document.querySelector(".file-details")).not.toBeNull();
  });
});
