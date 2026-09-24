import { describe, it, expect } from "vitest";
import { resolveOffsetInLine } from "./lspPosition";

describe("resolveOffsetInLine", () => {
  it("returns null for an offset inside a gutter node", () => {
    const lineEl = document.createElement("div");
    lineEl.className = "workspace-code-line";
    lineEl.setAttribute("data-line", "5");

    const gutterEl = document.createElement("span");
    gutterEl.className = "workspace-code-gutter";
    const gutterText = document.createTextNode("5");
    gutterEl.appendChild(gutterText);

    const contentEl = document.createElement("span");
    contentEl.className = "workspace-code-content";
    const contentText = document.createTextNode("const x = 1;");
    contentEl.appendChild(contentText);

    lineEl.appendChild(gutterEl);
    lineEl.appendChild(contentEl);

    // Click inside the gutter text
    const result = resolveOffsetInLine(gutterText, 0);
    expect(result).toBeNull();
  });

  it("returns correct {line, character} for an offset inside simple content", () => {
    const lineEl = document.createElement("div");
    lineEl.className = "workspace-code-line";
    lineEl.setAttribute("data-line", "5");

    const gutterEl = document.createElement("span");
    gutterEl.className = "workspace-code-gutter";
    gutterEl.appendChild(document.createTextNode("5"));

    const contentEl = document.createElement("span");
    contentEl.className = "workspace-code-content";
    const contentText = document.createTextNode("const x = 1;");
    contentEl.appendChild(contentText);

    lineEl.appendChild(gutterEl);
    lineEl.appendChild(contentEl);

    // Offset 6 is at 'x'
    const result = resolveOffsetInLine(contentText, 6);
    expect(result).toEqual({ line: 4, character: 6 });
  });

  it("computes character offset correctly across Shiki span boundaries", () => {
    const lineEl = document.createElement("div");
    lineEl.className = "workspace-code-line";
    lineEl.setAttribute("data-line", "10");

    const gutterEl = document.createElement("span");
    gutterEl.className = "workspace-code-gutter";
    gutterEl.appendChild(document.createTextNode("10"));

    const contentEl = document.createElement("span");
    contentEl.className = "workspace-code-content workspace-code-content--shiki";

    const span1 = document.createElement("span");
    span1.textContent = "const"; // 5 chars
    const space1 = document.createTextNode(" "); // 1 char
    const span2 = document.createElement("span");
    const greetingText = document.createTextNode("greeting"); // 8 chars
    span2.appendChild(greetingText);
    const space2 = document.createTextNode(" = "); // 3 chars
    const span3 = document.createElement("span");
    span3.textContent = '"hello"'; // 7 chars
    const semiText = document.createTextNode(";"); // 1 char

    contentEl.appendChild(span1);
    contentEl.appendChild(space1);
    contentEl.appendChild(span2);
    contentEl.appendChild(space2);
    contentEl.appendChild(span3);
    contentEl.appendChild(semiText);

    lineEl.appendChild(gutterEl);
    lineEl.appendChild(contentEl);

    // Offset inside "greeting" at index 4 ("gree" -> before 't')
    // 5 ("const") + 1 (" ") + 4 = 10
    const result1 = resolveOffsetInLine(greetingText, 4);
    expect(result1).toEqual({ line: 9, character: 10 });

    // Offset at semiText (index 1 -> after ';')
    // 5 + 1 + 8 + 3 + 7 + 1 = 25
    const result2 = resolveOffsetInLine(semiText, 1);
    expect(result2).toEqual({ line: 9, character: 25 });
  });

  it("returns null when node is outside any code line", () => {
    const div = document.createElement("div");
    const text = document.createTextNode("some text");
    div.appendChild(text);

    const result = resolveOffsetInLine(text, 2);
    expect(result).toBeNull();
  });
});
