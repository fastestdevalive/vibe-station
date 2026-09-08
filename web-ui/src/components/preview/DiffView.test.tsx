import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DiffView } from "./DiffView";

describe("DiffView oldText/newText prop path (4.T1)", () => {
  it("renders one removed line and one added line for a single-line change", () => {
    const { container } = render(<DiffView oldText={"a\nb"} newText={"a\nc"} />);
    const removed = container.querySelectorAll(".diff-line--removed");
    const added = container.querySelectorAll(".diff-line--added");
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(removed[0]!.textContent).toContain("b");
    expect(added[0]!.textContent).toContain("c");
  });

  it("treats an absent oldText as a brand-new file (all-added)", () => {
    const { container } = render(<DiffView newText={"line1\nline2"} />);
    const added = container.querySelectorAll(".diff-line--added");
    const removed = container.querySelectorAll(".diff-line--removed");
    expect(added).toHaveLength(2);
    expect(removed).toHaveLength(0);
  });
});

describe("DiffView regression — existing diffText/heuristic path (4.T4)", () => {
  it("still renders identically for unified-diff text with no structured diff props", () => {
    const diffText = [
      "@@ -1,2 +1,2 @@",
      " context line",
      "-old line",
      "+new line",
    ].join("\n");
    const { container } = render(<DiffView diffText={diffText} />);
    expect(container.querySelectorAll(".diff-line--removed")).toHaveLength(1);
    expect(container.querySelectorAll(".diff-line--added")).toHaveLength(1);
    expect(container.querySelectorAll(".diff-line--context")).toHaveLength(1);
  });
});

describe("DiffView Source/Rendered toggle for .md files (9.T3)", () => {
  const diffText = "@@ -1 +1,2 @@\n # Demo\n+added line\n";

  it("shows no toggle for a non-markdown file", () => {
    render(<DiffView diffText={diffText} filePath="src/App.tsx" fileContentFallback="# Demo\n" />);
    expect(screen.queryByRole("button", { name: "Rendered" })).not.toBeInTheDocument();
  });

  it("clicking Rendered shows MarkdownView output instead of raw diff text", async () => {
    const user = userEvent.setup();
    render(<DiffView diffText={diffText} filePath="README.md" fileContentFallback={"# Demo\n\nsome body text\n"} />);
    // Defaults to Source — raw diff lines are present.
    expect(screen.getByText("added line")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Rendered" }));
    // Rendered markdown heading, not the raw diff-line text.
    expect(await screen.findByRole("heading", { name: "Demo" })).toBeInTheDocument();
    expect(screen.queryByText("added line")).not.toBeInTheDocument();
  });
});
