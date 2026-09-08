import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach } from "vitest";
import { ChangedFileList } from "./ChangedFileList";
import { useWorkspaceStore } from "@/hooks/useStore";
import type { ChangedPathEntry } from "@/api/types";

const ENTRIES: ChangedPathEntry[] = [
  { path: "src/App.tsx", status: "M" },
  { path: "src/main.tsx", status: "M" },
  { path: "README.md", status: "A" },
];

describe("ChangedFileList — regression after useRovingListNav swap-in (Phase 8, 8.T3)", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ activeFilePath: null });
  });

  it("click-to-select still sets the active file", async () => {
    const user = userEvent.setup();
    render(<ChangedFileList entries={ENTRIES} />);

    await user.click(screen.getByText("App.tsx"));
    expect(useWorkspaceStore.getState().activeFilePath).toBe("src/App.tsx");
  });

  it("dir-header click still collapses/expands its group", async () => {
    const user = userEvent.setup();
    render(<ChangedFileList entries={ENTRIES} />);

    const dirHeader = screen.getByRole("button", { name: /src/ });
    expect(screen.getByText("App.tsx")).toBeInTheDocument();

    await user.click(dirHeader);
    expect(screen.queryByText("App.tsx")).not.toBeInTheDocument();

    await user.click(dirHeader);
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
  });

  it("ArrowDown/ArrowUp roving nav moves a visible cursor across groups, Enter opens", async () => {
    const user = userEvent.setup();
    render(<ChangedFileList entries={ENTRIES} />);

    // Groups render in the order they first appear in the (dir, name)-sorted
    // flat list: root ("") before "src" — so README.md, then App.tsx, main.tsx.
    const readmeRow = screen.getByText("README.md").closest('[role="treeitem"]')!;
    await user.click(readmeRow);
    expect(readmeRow).toHaveClass("changed-file-list-file--cursor");

    await user.keyboard("{ArrowDown}");
    const appRow = screen.getByText("App.tsx").closest('[role="treeitem"]')!;
    expect(appRow).toHaveClass("changed-file-list-file--cursor");

    await user.keyboard("{ArrowDown}");
    const mainRow = screen.getByText("main.tsx").closest('[role="treeitem"]')!;
    expect(mainRow).toHaveClass("changed-file-list-file--cursor");

    await user.keyboard("{Enter}");
    expect(useWorkspaceStore.getState().activeFilePath).toBe("src/main.tsx");
  });

  it("the first row is tabbable (tabIndex 0) before any row has been clicked", () => {
    render(<ChangedFileList entries={ENTRIES} />);

    const readmeRow = screen.getByText("README.md").closest('[role="treeitem"]')!;
    const appRow = screen.getByText("App.tsx").closest('[role="treeitem"]')!;
    const mainRow = screen.getByText("main.tsx").closest('[role="treeitem"]')!;
    expect(readmeRow).toHaveAttribute("tabIndex", "0");
    expect(appRow).toHaveAttribute("tabIndex", "-1");
    expect(mainRow).toHaveAttribute("tabIndex", "-1");
  });

  it("Space opens the focused row (restored pre-refactor Space-to-open convention)", async () => {
    const user = userEvent.setup();
    render(<ChangedFileList entries={ENTRIES} />);

    const appRow = screen.getByText("App.tsx").closest('[role="treeitem"]')! as HTMLElement;
    act(() => appRow.focus());
    expect(appRow).toHaveClass("changed-file-list-file--cursor");
    expect(useWorkspaceStore.getState().activeFilePath).toBe(null);

    await user.keyboard(" ");
    expect(useWorkspaceStore.getState().activeFilePath).toBe("src/App.tsx");
  });
});

describe("ChangedFileList — per-file +N -N LOC indicator", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ activeFilePath: null });
  });

  it("renders +N -N next to the status badge when insertions/deletions are present", () => {
    const entries: ChangedPathEntry[] = [
      { path: "src/App.tsx", status: "M", insertions: 3, deletions: 1 },
    ];
    render(<ChangedFileList entries={entries} />);
    const row = screen.getByText("App.tsx").closest('[role="treeitem"]')!;
    expect(row.querySelector(".changed-file-list-file__loc")).toBeInTheDocument();
    expect(row).toHaveTextContent("+3");
    expect(row).toHaveTextContent("−1");
  });

  it("omits the +N -N chip entirely when insertions/deletions are both undefined (binary file)", () => {
    const entries: ChangedPathEntry[] = [{ path: "assets/logo.png", status: "M" }];
    render(<ChangedFileList entries={entries} />);
    const row = screen.getByText("logo.png").closest('[role="treeitem"]')!;
    expect(row.querySelector(".changed-file-list-file__loc")).not.toBeInTheDocument();
  });

  it("omits the deletions span (not '−0') when deletions is 0", () => {
    const entries: ChangedPathEntry[] = [
      { path: "src/App.tsx", status: "M", insertions: 2, deletions: 0 },
    ];
    render(<ChangedFileList entries={entries} />);
    const row = screen.getByText("App.tsx").closest('[role="treeitem"]')!;
    expect(row).toHaveTextContent("+2");
    expect(row.querySelector(".vcs-graph__del")).not.toBeInTheDocument();
  });
});
