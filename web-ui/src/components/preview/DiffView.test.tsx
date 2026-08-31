import { render } from "@testing-library/react";
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
