import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { CodeView } from "./CodeView";

describe("CodeView", () => {
  it("5.T1: renders line with added modifier class when gutterMarks contains that line", () => {
    const code = "line 1\nline 2 added\nline 3";
    const gutterMarks = new Map<number, "added" | "modified" | "deleted">([
      [2, "added"],
    ]);
    const { container } = render(
      <CodeView
        code={code}
        gutterMarks={gutterMarks}
        filePath="test.txt"
      />
    );

    const lines = container.querySelectorAll(".workspace-code-line");
    expect(lines.length).toBe(3);
    expect(lines[1]!.className).toContain("workspace-code-line--added");
  });

  it("5.T2: line with no gutterMarks entry renders without modifier class", () => {
    const code = "line 1\nline 2\nline 3";
    const gutterMarks = new Map<number, "added" | "modified" | "deleted">([
      [2, "added"],
    ]);
    const { container } = render(
      <CodeView
        code={code}
        gutterMarks={gutterMarks}
        filePath="test.txt"
      />
    );

    const lines = container.querySelectorAll(".workspace-code-line");
    expect(lines[0]!.className).not.toContain("workspace-code-line--");
    expect(lines[2]!.className).not.toContain("workspace-code-line--");
  });

  it("5.T2: noGutter={true} suppresses modifier classes even when gutterMarks has entries", () => {
    const code = "line 1\nline 2\nline 3";
    const gutterMarks = new Map<number, "added" | "modified" | "deleted">([
      [1, "modified"],
      [2, "deleted"],
    ]);
    const { container } = render(
      <CodeView
        code={code}
        gutterMarks={gutterMarks}
        noGutter={true}
        filePath="test.txt"
      />
    );

    const lines = container.querySelectorAll(".workspace-code-line");
    expect(lines[0]!.className).not.toContain("workspace-code-line--");
    expect(lines[1]!.className).not.toContain("workspace-code-line--");
    // Also verify that gutter itself is not rendered when noGutter is true
    const gutters = container.querySelectorAll(".workspace-code-gutter");
    expect(gutters.length).toBe(0);
  });

  it("renders modified marker on the correct line", () => {
    const code = "line 1\nline 2\nline 3 modified";
    const gutterMarks = new Map<number, "added" | "modified" | "deleted">([
      [3, "modified"],
    ]);
    const { container } = render(
      <CodeView
        code={code}
        gutterMarks={gutterMarks}
        filePath="test.txt"
      />
    );

    const lines = container.querySelectorAll(".workspace-code-line");
    expect(lines[2]!.className).toContain("workspace-code-line--modified");
  });

  it("renders deleted marker on the correct line", () => {
    const code = "line 1 deleted\nline 2\nline 3";
    const gutterMarks = new Map<number, "added" | "modified" | "deleted">([
      [1, "deleted"],
    ]);
    const { container } = render(
      <CodeView
        code={code}
        gutterMarks={gutterMarks}
        filePath="test.txt"
      />
    );

    const lines = container.querySelectorAll(".workspace-code-line");
    expect(lines[0]!.className).toContain("workspace-code-line--deleted");
  });
});
