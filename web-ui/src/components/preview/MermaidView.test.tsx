import { render, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import mermaid from "mermaid";
import { MermaidView, sanitizeSvg } from "./MermaidView";

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

  it("fullscreen blob is well-formed XML for <br/> labels (no broken image)", async () => {
    mockedMermaid.render.mockResolvedValueOnce({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel">claude<br />live Rich Chat session</span></div></foreignObject></svg>',
    });
    const blobs: Blob[] = [];
    const create = vi.fn((b: Blob) => (blobs.push(b), "blob:mock"));
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = create as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    try {
      const { container } = render(<MermaidView chart="graph TD; A[claude<br/>x]-->B" theme="dark" />);
      await waitFor(() => expect(container.querySelector(".mermaid-view--clickable")).toBeTruthy());
      fireEvent.click(container.querySelector(".mermaid-view--clickable") as HTMLElement);
      expect(blobs).toHaveLength(1);
      const text = await new Promise<string>((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.readAsText(blobs[0] as Blob);
      });
      const doc = new DOMParser().parseFromString(text, "image/svg+xml");
      expect(doc.querySelector("parsererror"), text).toBeNull();
      expect(doc.documentElement.namespaceURI).toBe("http://www.w3.org/2000/svg");
      expect(text).toContain("live Rich Chat session");
      expect(text).toContain("<br");
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });

  it("does NOT open fullscreen from a failed render (<pre> fallback not clickable)", async () => {
    mockedMermaid.render.mockRejectedValueOnce(new Error("boom"));
    const { container } = render(<MermaidView chart="not a diagram" theme="dark" />);
    await waitFor(() => expect(container.querySelector(".mermaid-fallback")).toBeTruthy());
    expect(container.querySelector(".mermaid-view--clickable")).toBeNull();
    expect(document.body.querySelector(".image-zoom-overlay")).toBeNull();
  });
});

describe("MermaidView sanitizeSvg (2.4)", () => {
  it("strips script and onerror while keeping foreignObject labels", () => {
    const out = sanitizeSvg(
      '<svg><foreignObject><div class="label">Hi</div></foreignObject><script>alert(1)</script><img src=x onerror=alert(1)></svg>',
    );
    expect(out).toContain("Hi");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onerror");
  });

  it("keeps dominant-baseline on text", () => {
    const out = sanitizeSvg('<svg><text dominant-baseline="middle">x</text></svg>');
    expect(out).toContain('dominant-baseline="middle"');
  });

  it("does not put an onerror element into the rendered container", async () => {
    mockedMermaid.render.mockResolvedValueOnce({
      svg: '<svg><img src=x onerror=alert(1)></svg>',
    });
    const { container } = render(<MermaidView chart="graph TD; A-->B" theme="dark" />);
    await waitFor(() => expect(container.querySelector(".mermaid-view")?.innerHTML).toContain("svg"));
    expect(container.querySelector(".mermaid-view [onerror]")).toBeNull();
  });
});

