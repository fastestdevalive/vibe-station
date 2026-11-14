import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import type { FileStat } from "@/api/types";
import { copyText } from "@/lib/copyText";
import { FileStrip, baseNameOf, type FileStripProps } from "./FileStrip";

vi.mock("@/lib/copyText", () => ({ copyText: vi.fn(async () => true) }));

const stat: FileStat = {
  path: "web-ui/src/a.ts",
  absolutePath: "/repo/web-ui/src/a.ts",
  kind: "file",
  size: 1,
  modifiedMs: 1,
  lineCount: 1,
  inRoot: true,
};
const api = { statPath: vi.fn(async () => stat) } as unknown as ApiInstance;

function props(over: Partial<FileStripProps> = {}): FileStripProps {
  return {
    variant: "file",
    path: "web-ui/src/a.ts",
    displayDir: "web-ui/src",
    copyValue: "web-ui/src/a.ts",
    stats: { additions: 12, deletions: 3 },
    statsTitle: "Compared to HEAD",
    nav: { canGoBack: true, canGoForward: false, onBack: vi.fn(), onForward: vi.fn() },
    view: <span data-testid="view">view</span>,
    menu: {
      api,
      target: { scope: "worktree", scopeId: "wt1", path: "web-ui/src/a.ts", name: "a.ts" },
      variant: "file",
      font: { scale: 1, bump: vi.fn(), reset: vi.fn() },
      scrollMap: null,
    },
    ...over,
  };
}

describe("FileStrip", () => {
  beforeEach(() => {
    vi.mocked(copyText).mockClear();
  });

  it("root children: the scrolling main row, the view switch, one menu; main holds nav, name, counts, directory", () => {
    const { container } = render(<FileStrip {...props()} />);
    const root = container.querySelector(".preview-diffinfo") as HTMLElement;
    const kids = Array.from(root.children);
    expect(kids).toHaveLength(3);
    expect(kids[0]).toHaveClass("file-strip__main");
    expect(kids[1]).toBe(screen.getByTestId("view"));
    expect(kids[2]).toHaveAttribute("aria-label", "File menu");
    const main = Array.from(kids[0]?.children ?? []);
    expect(main[0]).toHaveClass("file-strip__nav");
    expect(main[1]).toHaveClass("file-strip__name");
    expect(main[2]).toHaveClass("file-strip__stats");
    expect(main[3]).toHaveClass("file-strip__dir");
    expect(main).toHaveLength(4);
    expect(root.querySelector(".file-strip__sp")).toBeNull();
    expect(root.querySelectorAll("[aria-label='File menu']")).toHaveLength(1);
  });

  it("the name is the basename, whole; the directory is a bdi so its text keeps its order", () => {
    render(<FileStrip {...props()} />);
    const name = screen.getByRole("button", { name: "a.ts" });
    expect(name).toHaveClass("file-strip__name");
    expect(name.querySelector("bdi")).toBeNull();
    const dir = screen.getByRole("button", { name: "web-ui/src" });
    expect(dir).toHaveClass("file-strip__dir");
    expect(dir.querySelector("bdi")).toHaveTextContent("web-ui/src");
  });

  it("counts carry the scope label as their tooltip, not as text", () => {
    render(<FileStrip {...props()} />);
    const counts = screen.getByLabelText("Diff line counts");
    expect(counts).toHaveAttribute("title", "Compared to HEAD");
    expect(counts).toHaveTextContent("+12");
    expect(counts).toHaveTextContent("−3");
    expect(screen.queryByText("Compared to HEAD")).toBeNull();
  });

  it("clicking the name or the directory copies the given value synchronously (no await before the clipboard write)", () => {
    render(<FileStrip {...props({ variant: "artifact", copyValue: "/Users/x/out/report.html" })} />);
    fireEvent.click(screen.getByRole("button", { name: "a.ts" }));
    expect(copyText).toHaveBeenLastCalledWith("/Users/x/out/report.html");
    fireEvent.click(screen.getByRole("button", { name: "web-ui/src" }));
    expect(copyText).toHaveBeenCalledTimes(2);
    expect(copyText).toHaveBeenLastCalledWith("/Users/x/out/report.html");
  });

  it("the commit variant has no back / forward buttons", () => {
    const { container } = render(<FileStrip {...props({ variant: "commit", nav: null })} />);
    expect(container.querySelector(".file-strip__nav")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("baseNameOf takes the last segment of / or \\ paths", () => {
    expect(baseNameOf("a/b/c.ts")).toBe("c.ts");
    expect(baseNameOf("C:\\x\\y.md")).toBe("y.md");
    expect(baseNameOf("plain")).toBe("plain");
  });
});
