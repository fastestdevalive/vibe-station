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

  it("falls back to a <pre> code block when render() throws", async () => {
    mockedMermaid.render.mockRejectedValueOnce(new Error("parse error"));
    const { container } = render(<MermaidView chart="not a diagram" theme="dark" />);
    await waitFor(() => expect(container.querySelector(".mermaid-fallback")).toBeTruthy());
    expect(container.querySelector(".mermaid-fallback")?.textContent).toContain("not a diagram");
  });

  it("does NOT call parse() before render() — render is the sole gate", async () => {
    const { container } = render(<MermaidView chart="graph TD; A-->B" theme="dark" />);
    await waitFor(() => expect(container.querySelector(".mermaid-view")?.innerHTML).toContain("svg"));
    // parse() must never be called — render() is the only gate now.
    expect(mockedMermaid.parse).not.toHaveBeenCalled();
  });

  it("renders a chart that parse() would reject but render() can handle (e.g. | in diamond node)", async () => {
    // Simulate the case where parse() would have returned false (|  in diamond)
    // but render() succeeds — this is the fix for plan diagrams with such syntax.
    mockedMermaid.parse.mockResolvedValueOnce(false); // Would have blocked render in old code.
    const chart = "flowchart LR\n    DeleteRoute --> Guard{done|exited?}\n    Guard --yes--> Purge";
    const { container } = render(<MermaidView chart={chart} theme="dark" />);
    await waitFor(() => expect(container.querySelector(".mermaid-view")?.innerHTML).toContain("svg"));
    // parse() must never be called — render() is the only gate now.
    expect(mockedMermaid.parse).not.toHaveBeenCalled();
  });

  it("falls back without an unhandled rejection when render() throws", async () => {
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
