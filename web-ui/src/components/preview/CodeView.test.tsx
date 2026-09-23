import { render, waitFor } from "@testing-library/react";
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

  // Two-part jump-to-line highlight: whole-line background + matched substring.
  it("highlightLine adds the target modifier class to the matching line only", () => {
    const code = "line 1\nline 2\nline 3";
    const { container } = render(<CodeView code={code} filePath="test.txt" highlightLine={2} />);

    const lines = container.querySelectorAll(".workspace-code-line");
    expect(lines[0]!.className).not.toContain("workspace-code-line--target");
    expect(lines[1]!.className).toContain("workspace-code-line--target");
    expect(lines[2]!.className).not.toContain("workspace-code-line--target");
  });

  it("highlightMatchText marks the matched substring within the target line", () => {
    const code = "const x = 1;\nconst hello = 2;\nconst z = 3;";
    const { container } = render(
      <CodeView code={code} filePath="test.txt" highlightLine={2} highlightMatchText="hello" />,
    );

    const lines = container.querySelectorAll(".workspace-code-line");
    const mark = lines[1]!.querySelector("mark.workspace-code-match");
    expect(mark).toBeTruthy();
    expect(mark?.textContent).toBe("hello");
    // Surrounding text is preserved around the mark.
    expect(lines[1]!.querySelector(".workspace-code-content")?.textContent).toBe("const hello = 2;");
  });

  it("no mark rendered when highlightMatchText isn't found on the target line", () => {
    const code = "const x = 1;\nconst y = 2;";
    const { container } = render(
      <CodeView code={code} filePath="test.txt" highlightLine={2} highlightMatchText="nope" />,
    );

    expect(container.querySelector("mark.workspace-code-match")).toBeNull();
    // Line highlight still applies even without a match-text hit.
    const lines = container.querySelectorAll(".workspace-code-line");
    expect(lines[1]!.className).toContain("workspace-code-line--target");
  });

  // Live-review feedback — syntax colors must survive the match highlight,
  // not just the fallback plain-text path (which never had colors to lose).
  it("preserves Shiki syntax-highlighting spans around the mark, for a match that spans a single token", async () => {
    const code = "const hello = 2;\nconst world = 3;";
    const { container } = render(
      <CodeView code={code} filePath="test.ts" highlightLine={1} highlightMatchText="hello" />,
    );

    await waitFor(() => {
      expect(container.querySelector(".workspace-code-content--shiki")).toBeTruthy();
    });
    await waitFor(() => {
      expect(container.querySelector("mark.workspace-code-match")).toBeTruthy();
    });

    const targetContent = container.querySelectorAll(".workspace-code-line")[0]!.querySelector(".workspace-code-content");
    // Shiki's own coloring survives: the content still carries its shiki
    // marker class, not a bare plain-text fallback span.
    expect(targetContent).toHaveClass("workspace-code-content--shiki");
    // At least one sibling/ancestor token still carries Shiki's inline color
    // style — i.e. this isn't the old plain-text-splice fallback, which had
    // none at all.
    expect(container.querySelector('.workspace-code-content--shiki [style*="color"]')).toBeTruthy();
    const mark = container.querySelector("mark.workspace-code-match");
    expect(mark?.textContent).toBe("hello");
  });

  it("preserves Shiki syntax-highlighting when a match spans multiple tokens", async () => {
    const code = "const helloWorld = x + y;";
    const { container } = render(
      <CodeView code={code} filePath="test.ts" highlightLine={1} highlightMatchText="x + y" />,
    );

    await waitFor(() => {
      expect(container.querySelector(".workspace-code-content--shiki")).toBeTruthy();
    });
    await waitFor(() => {
      expect(container.querySelector("mark.workspace-code-match")).toBeTruthy();
    });

    // A multi-token match gets one <mark> per contributing Shiki span (not
    // one mark spanning all of them — see markMatchInElement's own comment)
    // — combined, their text reconstructs the full match with no gaps.
    const marks = container.querySelectorAll("mark.workspace-code-match");
    expect(marks.length).toBeGreaterThan(1);
    expect(Array.from(marks).map((m) => m.textContent).join("")).toBe("x + y");
    expect(container.querySelector(".workspace-code-content--shiki")).toHaveClass("workspace-code-content--shiki");
  });
});
