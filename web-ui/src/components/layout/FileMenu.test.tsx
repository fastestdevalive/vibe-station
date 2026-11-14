import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import type { FileStat } from "@/api/types";
import { useDetailsStore, type DetailsTarget } from "@/components/details/detailsStore";
import { copyText } from "@/lib/copyText";
import { FileMenu, type FileMenuProps } from "./FileMenu";

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
const target: DetailsTarget = { scope: "worktree", scopeId: "wt1", path: "web-ui/src/a.ts", name: "a.ts" };

function setup(over: Partial<FileMenuProps> = {}) {
  const statPath = vi.fn(async () => stat);
  const api = { statPath } as unknown as ApiInstance;
  const bump = vi.fn();
  const reset = vi.fn();
  const props: FileMenuProps = {
    api,
    target,
    variant: "file",
    font: { scale: 1, bump, reset },
    scrollMap: { display: "marks", forced: null },
    ...over,
  };
  render(<FileMenu {...props} />);
  return { statPath, bump, reset };
}

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "File menu" }));
}

describe("FileMenu", () => {
  beforeEach(() => {
    vi.mocked(copyText).mockClear();
    useDetailsStore.setState({ target: null });
  });

  it("commit variant offers Open in Files and no Pin; artifact variant offers Pin and no Open in Files", () => {
    const { unmount } = render(
      <FileMenu
        api={{ statPath: vi.fn(async () => stat) } as unknown as ApiInstance}
        target={target}
        variant="commit"
        onOpenInFiles={vi.fn()}
        font={{ scale: 1, bump: vi.fn(), reset: vi.fn() }}
        scrollMap={null}
      />,
    );
    openMenu();
    expect(screen.getByRole("menuitem", { name: "Open in Files" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Pin" })).toBeNull();
    unmount();

    setup({
      variant: "artifact",
      pin: { pinned: false, onToggle: vi.fn(async () => null) },
      onOpenInFiles: undefined,
    });
    openMenu();
    expect(screen.getByRole("menuitem", { name: "Pin" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Open in Files" })).toBeNull();
  });

  it("Details opens the Details store with the target", () => {
    setup();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Details" }));
    expect(useDetailsStore.getState().target).toEqual(target);
  });

  it("opening the menu calls statPath once; Copy path then copies stat.absolutePath synchronously", async () => {
    const { statPath } = setup();
    openMenu();
    await waitFor(() => expect(statPath).toHaveBeenCalledTimes(1));
    expect(statPath).toHaveBeenCalledWith("wt1", "web-ui/src/a.ts", "worktree", undefined);
    // The stat is held in state by now; the copy itself happens inside the click handler.
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));
    expect(copyText).toHaveBeenCalledWith("/repo/web-ui/src/a.ts");
  });

  it("Text size + and − call the font bump; the percentage resets", () => {
    const { bump, reset } = setup();
    openMenu();
    expect(screen.getByRole("group", { name: "Text size" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Increase text size" }));
    expect(bump).toHaveBeenLastCalledWith(0.05);
    fireEvent.click(screen.getByRole("button", { name: "Decrease text size" }));
    expect(bump).toHaveBeenLastCalledWith(-0.05);
    // At 100% the reset is disabled.
    expect(screen.getByRole("button", { name: "Reset text size" })).toBeDisabled();
    expect(reset).not.toHaveBeenCalled();
  });

  it("the scroll-map group shows only when the mode is not forced", () => {
    setup({ scrollMap: { display: "minimap", forced: "fits" } });
    openMenu();
    expect(screen.queryByRole("group", { name: "Scroll map" })).toBeNull();
  });

  it("the scroll-map group offers Minimap and Marks when not forced", () => {
    setup({ scrollMap: { display: "marks", forced: null } });
    openMenu();
    const group = screen.getByRole("group", { name: "Scroll map" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Minimap" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Marks" })).toBeInTheDocument();
  });
});
