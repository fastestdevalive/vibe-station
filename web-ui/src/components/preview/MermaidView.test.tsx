import { render, waitFor, fireEvent } from "@testing-library/react";
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

  it("renders a chart with | in diamond node by sanitizing before render()", async () => {
    // The sanitizer replaces `|` inside `{…}` with " or " so mermaid can render
    // the diamond. render() receives the sanitized source; the original chart
    // is preserved for the fallback display path.
    const chart = "flowchart LR\n    DeleteRoute --> Guard{done|exited?}\n    Guard --yes--> Purge";
    const { container } = render(<MermaidView chart={chart} theme="dark" />);
    await waitFor(() => expect(container.querySelector(".mermaid-view")?.innerHTML).toContain("svg"));
    // render() must have been called with "or" replacing "|" inside {…}
    expect(mockedMermaid.render).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("Guard{done or exited?}"),
    );
    // parse() must never be called
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

describe("MermaidView fullscreen (4.T1)", () => {
  it("wraps a successful render in a clickable wrapper (role=button)", async () => {
    const { container } = render(<MermaidView chart="graph TD; A-->B" theme="dark" />);
    await waitFor(() => expect(container.querySelector(".mermaid-view")?.innerHTML).toContain("svg"));
    const clickable = container.querySelector(".mermaid-view--clickable");
    expect(clickable).toBeTruthy();
    expect(clickable?.getAttribute("role")).toBe("button");
  });

  it("opens the shared fullscreen overlay on click", async () => {
    const { container } = render(<MermaidView chart="graph TD; A-->B" theme="dark" />);
    await waitFor(() => expect(container.querySelector(".mermaid-view")?.innerHTML).toContain("svg"));
    fireEvent.click(container.querySelector(".mermaid-view--clickable") as HTMLElement);
    // Portal renders into document.body.
    expect(document.body.querySelector(".image-zoom-overlay")).toBeTruthy();
    expect(document.body.querySelector(".image-zoom-overlay img")).toBeTruthy();
  });

  it("does NOT open fullscreen from a failed render (<pre> fallback not clickable)", async () => {
    mockedMermaid.render.mockRejectedValueOnce(new Error("boom"));
    const { container } = render(<MermaidView chart="not a diagram" theme="dark" />);
    await waitFor(() => expect(container.querySelector(".mermaid-fallback")).toBeTruthy());
    expect(container.querySelector(".mermaid-view--clickable")).toBeNull();
    expect(document.body.querySelector(".image-zoom-overlay")).toBeNull();
  });
});

