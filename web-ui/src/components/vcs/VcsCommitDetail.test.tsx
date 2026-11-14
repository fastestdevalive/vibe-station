import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangedPathEntry, CommitLogEntry } from "@/api/types";
import { copyText } from "@/lib/copyText";
import { VcsCommitDetail, type VcsCommitDetailProps } from "./VcsCommitDetail";

vi.mock("@/lib/copyText", () => ({ copyText: vi.fn(async () => true) }));

const SHA = "d".repeat(40);
const commit: CommitLogEntry = {
  sha: SHA,
  shortSha: "ddddddd",
  authorName: "Ada Lovelace",
  authorEmail: "ada@example.com",
  date: "2026-01-01T00:00:00Z",
  subject: "tidy the sidebar",
  body: "tidy the sidebar\n\nlonger body",
  insertions: 12,
  deletions: 4,
  hasBinaryChanges: false,
  isOnBranch: true,
};
const entries: ChangedPathEntry[] = [
  { path: "src/a.ts", status: "M" },
  { path: "src/b.ts", status: "A" },
];

const api = { statPath: vi.fn(async () => ({ path: "", absolutePath: "/repo/x", kind: "file" as const, size: 1, modifiedMs: 1, lineCount: 1, inRoot: true })) };

function props(over: Partial<VcsCommitDetailProps> = {}): VcsCommitDetailProps {
  return {
    api,
    scopeId: "wt1",
    scope: "worktree",
    commit,
    sha: SHA,
    entries,
    filesLoading: false,
    filesError: null,
    selectedPath: "src/a.ts",
    onSelectPath: vi.fn(),
    canOlder: true,
    canNewer: true,
    onOlder: vi.fn(),
    onNewer: vi.fn(),
    onUp: vi.fn(),
    ...over,
  };
}

describe("VcsCommitDetail", () => {
  beforeEach(() => {
    vi.mocked(copyText).mockClear();
  });

  it("older / newer buttons call their handlers and disable at the ends", () => {
    const p = props({ canOlder: false, canNewer: true });
    render(<VcsCommitDetail {...p} />);
    expect(screen.getByRole("button", { name: "Older commit" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Newer commit" }));
    expect(p.onNewer).toHaveBeenCalledTimes(1);
    expect(p.onOlder).not.toHaveBeenCalled();
  });

  it("] steps older and [ steps newer, when enabled", () => {
    const p = props();
    const { container } = render(<VcsCommitDetail {...p} />);
    const root = container.querySelector(".vcs-commit-detail")!;
    fireEvent.keyDown(root, { key: "]" });
    expect(p.onOlder).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(root, { key: "[" });
    expect(p.onNewer).toHaveBeenCalledTimes(1);
  });

  it("] and [ do nothing at the ends", () => {
    const p = props({ canOlder: false, canNewer: false });
    const { container } = render(<VcsCommitDetail {...p} />);
    const root = container.querySelector(".vcs-commit-detail")!;
    fireEvent.keyDown(root, { key: "]" });
    fireEvent.keyDown(root, { key: "[" });
    expect(p.onOlder).not.toHaveBeenCalled();
    expect(p.onNewer).not.toHaveBeenCalled();
  });

  it("'‹ Commits' and Esc in the files list both go up one level", () => {
    const p = props();
    const { container } = render(<VcsCommitDetail {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /Commits$/ }));
    expect(p.onUp).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(container.querySelector(".vcs-commit-detail__files")!, { key: "Escape" });
    expect(p.onUp).toHaveBeenCalledTimes(2);
  });

  it("the sha click copies the full sha", () => {
    render(<VcsCommitDetail {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "ddddddd" }));
    expect(copyText).toHaveBeenCalledWith(SHA);
  });

  it("shows the subject, author, totals, the message toggle and the 'Files N' count; selecting a file calls onSelectPath", () => {
    const p = props();
    render(<VcsCommitDetail {...p} />);
    expect(screen.getByText("tidy the sidebar", { selector: ".vcs-commit-detail__subject" })).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("+12")).toBeInTheDocument();
    expect(screen.getByText("Files 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    expect(document.querySelector(".vcs-commit-detail__message")).toHaveTextContent("longer body");
    fireEvent.click(screen.getByText("b.ts"));
    expect(p.onSelectPath).toHaveBeenCalledWith("src/b.ts");
  });
});
