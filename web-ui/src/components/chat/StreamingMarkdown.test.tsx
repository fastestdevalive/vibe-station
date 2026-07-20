import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StreamingMarkdown, closeUnterminatedFences } from "./StreamingMarkdown";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn(async () => true),
    render: vi.fn(async () => ({ svg: "<svg data-testid='diagram'></svg>" })),
  },
}));

describe("closeUnterminatedFences", () => {
  it("closes an odd (unterminated) fence and leaves a closed one alone", () => {
    expect(closeUnterminatedFences("```ts\nconst x = 1")).toBe("```ts\nconst x = 1\n```");
    expect(closeUnterminatedFences("```ts\nconst x = 1\n```")).toBe("```ts\nconst x = 1\n```");
    expect(closeUnterminatedFences("no fences here")).toBe("no fences here");
  });
});

describe("StreamingMarkdown (4.T3)", () => {
  it("renders a fenced code block with a copy button and highlighted code", () => {
    const { container } = render(<StreamingMarkdown source={"```ts\nconst x = 1\n```"} />);
    expect(container.querySelector(".workspace-md-code-block")).toBeTruthy();
    expect(screen.getByRole("button", { name: /copy/i })).toBeTruthy();
    // rehype-highlight tags the <code> element with the language class.
    expect(container.querySelector("code.language-ts")).toBeTruthy();
    expect(container.textContent).toContain("const x = 1");
  });

  it("tolerates a partial/unterminated fence mid-stream without swallowing layout", () => {
    // A delta that opened a fence but hasn't closed it yet.
    const { container } = render(<StreamingMarkdown source={"here is code:\n```ts\nconst x = 1"} />);
    // The code content still renders inside a code block (not lost / not raw).
    expect(container.querySelector(".workspace-md-code-block")).toBeTruthy();
    expect(container.textContent).toContain("const x = 1");
    expect(container.textContent).toContain("here is code:");
  });

  it("sanitizes raw HTML and javascript: URLs (untrusted output)", () => {
    const { container } = render(
      <StreamingMarkdown source={'<script>window.__pwn=1</script>\n\n[click](javascript:alert(1))'} />,
    );
    // Raw <script> is not injected into the DOM.
    expect(container.querySelector("script")).toBeNull();
    // The link, if rendered, must not carry a javascript: href.
    const link = container.querySelector("a");
    if (link) {
      expect(link.getAttribute("href") ?? "").not.toMatch(/javascript:/i);
    }
    // The pwn side-effect never ran.
    expect((window as unknown as { __pwn?: number }).__pwn).toBeUndefined();
  });

  it("routes a closed ```mermaid fence to a MermaidView host, prose intact", async () => {
    const { container } = render(
      <StreamingMarkdown source={"Diagram below:\n\n```mermaid\ngraph TD; A-->B\n```"} />,
    );
    // Mermaid host renders; the surrounding prose is not swallowed.
    expect(container.querySelector(".mermaid-view")).toBeTruthy();
    expect(container.textContent).toContain("Diagram below:");
    // The chart is not left as a raw code block.
    await waitFor(() =>
      expect(container.querySelector(".mermaid-view")?.innerHTML).toContain("svg"),
    );
  });

  it("keeps an unterminated mermaid fence as a code block mid-stream (no host)", () => {
    const { container } = render(
      <StreamingMarkdown source={"Diagram below:\n\n```mermaid\ngraph TD; A-->B"} />,
    );
    // Still open → stays in the trailing markdown segment as a synthetic-closed
    // code block; no MermaidView host yet.
    expect(container.querySelector(".mermaid-view")).toBeNull();
    expect(container.querySelector(".workspace-md-code-block")).toBeTruthy();
    expect(container.textContent).toContain("graph TD; A-->B");
  });
});
