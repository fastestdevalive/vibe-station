import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { MarkdownView } from "@/components/preview/MarkdownView";

describe("MarkdownView", () => {
  it("renders headings and lists from GFM", () => {
    const src = "# Title\n\n- a\n- b\n";
    const { container } = render(<MarkdownView source={src} />);
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelectorAll("li").length).toBe(2);
  });

  it("strips script tags from output", () => {
    const src = "<script>alert(1)</script>\n\n# Hi";
    const { container } = render(<MarkdownView source={src} />);
    expect(container.querySelector("script")).toBeNull();
  });
});
