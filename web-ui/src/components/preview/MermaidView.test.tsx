import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import mermaid from "mermaid";
import { MermaidView } from "./MermaidView";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn(async () => true),
    render: vi.fn(async () => ({ svg: "<svg data-testid='diagram'></svg>" })),
  },
}));

// mermaid.parse's overloaded signature types return as ParseResult; the mock
// yields plain booleans, so reach the fns as bare vitest mocks.
const mockedMermaid = mermaid as unknown as { parse: Mock; render: Mock };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MermaidView hardening (RA2)", () => {
  it("renders the SVG for a valid chart", async () => {
    const { container } = render(<MermaidView chart="graph TD; A-->B" theme="dark" />);
    await waitFor(() => expect(container.querySelector(".mermaid-view")?.innerHTML).toContain("svg"));
  });

  it("falls back to a <pre> code block when parse reports invalid", async () => {
    mockedMermaid.parse.mockResolvedValueOnce(false);
    const { container } = render(<MermaidView chart="not a diagram" theme="dark" />);
    await waitFor(() => expect(container.querySelector(".mermaid-fallback")).toBeTruthy());
    expect(container.querySelector(".mermaid-fallback")?.textContent).toContain("not a diagram");
    // render() must never be attempted on an unparseable chart.
    expect(mockedMermaid.render).not.toHaveBeenCalled();
  });

  it("falls back without an unhandled rejection when render() throws", async () => {
    mockedMermaid.parse.mockResolvedValueOnce(true);
    mockedMermaid.render.mockRejectedValueOnce(new Error("boom"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { container } = render(<MermaidView chart="graph TD; A-->B" theme="dark" />);
      await waitFor(() => expect(container.querySelector(".mermaid-fallback")).toBeTruthy());
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
