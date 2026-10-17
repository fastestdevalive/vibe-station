import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { HTML_CHAT_MAX_BYTES } from "@/components/preview/htmlDocument";
import { HtmlBlock } from "./HtmlBlock";
import { RowUiStateProvider } from "./rowUiState";

// Highlighting a ~260 KB source is slow in jsdom and irrelevant to what these tests assert.
vi.mock("@/components/preview/MarkdownView", () => ({
  MarkdownView: ({ source }: { source: string }) => <pre data-testid="md-source">{source}</pre>,
}));

describe("HtmlBlock (4.T4)", () => {
  it("tabs have role=tab with aria-controls matching a role=tabpanel id", () => {
    const { container } = render(<HtmlBlock source="<h1>Hi</h1>" />);
    const panel = container.querySelector('[role="tabpanel"]')!;
    const panelId = panel.getAttribute("id");
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(2);
    for (const tab of tabs) {
      expect(tab.getAttribute("aria-controls")).toBe(panelId);
    }
  });

  it("ArrowRight moves selection to Source", () => {
    const { container } = render(<HtmlBlock source="<h1>Hi</h1>" />);
    const selected = container.querySelector('[role="tab"][aria-selected="true"]')!;
    expect(selected.textContent).toBe("Preview");
    fireEvent.keyDown(selected, { key: "ArrowRight" });
    const sourceTab = container.querySelector('[role="tab"][aria-selected="true"]')!;
    expect(sourceTab.textContent).toBe("Source");
  });

  it("oversize starts on Source, disables Preview, and shows no iframe", () => {
    const big = "<p>x</p>\n".repeat(Math.ceil(HTML_CHAT_MAX_BYTES / 9) + 1);
    const { container } = render(<HtmlBlock source={big} />);
    const previewTab = container.querySelector('[role="tab"]:first-child')! as HTMLButtonElement;
    expect(previewTab.textContent).toBe("Preview");
    expect(previewTab.getAttribute("aria-selected")).toBe("false");
    expect(previewTab.disabled).toBe(true);
    expect(container.querySelector("iframe")).toBeNull();
    expect(previewTab.getAttribute("title")).toMatch(/too large/i);
    expect(container.querySelector(".html-view__notice")?.textContent).toMatch(/too large/i);
  });

  it("keeps tab, expand and light-canvas state across an unmount/remount via the row store", () => {
    // The provider must survive the card unmounting (as MessageList's does), so
    // keep ONE provider and toggle only the child.
    function Stable() {
      const [show, setShow] = useState(true);
      return (
        <RowUiStateProvider>
          <button onClick={() => setShow((v) => !v)}>toggle</button>
          {show ? <HtmlBlock source="<h1>Hi</h1>" stateKey="html:row1:0" /> : null}
        </RowUiStateProvider>
      );
    }
    const r = render(<Stable />);
    fireEvent.click(r.getByText("Expand"));
    fireEvent.click(r.getByText("Light canvas"));
    fireEvent.click(r.getByText("Source"));
    fireEvent.click(r.getByText("toggle")); // unmount the card
    expect(r.container.querySelector(".html-block")).toBeNull();
    fireEvent.click(r.getByText("toggle")); // remount it
    expect(r.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Source");
    fireEvent.click(r.getByText("Preview"));
    expect(r.getByText("Collapse")).toBeTruthy();
    expect(r.getByText("Light canvas").getAttribute("aria-pressed")).toBe("true");
  });

  it("Source tab hands the code to MarkdownView re-fenced as html (for highlighting)", () => {
    const r = render(<HtmlBlock source="<h1>Hi</h1>" />);
    fireEvent.click(r.getByText("Source"));
    expect(r.getByTestId("md-source").textContent).toBe("```html\n<h1>Hi</h1>\n```");
  });
});
