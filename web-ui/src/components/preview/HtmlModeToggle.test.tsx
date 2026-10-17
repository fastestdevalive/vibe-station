import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { HtmlModeToggle, useHtmlPreviewMode } from "./HtmlModeToggle";

function Probe() {
  const [mode, setMode] = useHtmlPreviewMode();
  return (
    <HtmlModeToggle
      mode={mode}
      onChange={(m) => setMode(m)}
    />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HtmlModeToggle", () => {
  it("hook returns 'rendered' when localStorage.getItem throws", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    render(<Probe />);
    expect(screen.getByRole("button", { name: "Rendered" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute("aria-pressed", "false");
    getItem.mockRestore();
  });

  it("clicking Source calls onChange('source')", () => {
    const onChange = vi.fn();
    render(
      <HtmlModeToggle
        mode="rendered"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(onChange).toHaveBeenCalledWith("source");
    fireEvent.click(screen.getByRole("button", { name: "Rendered" }));
    expect(onChange).toHaveBeenCalledWith("rendered");
  });

  it("renderDisabled disables only Rendered and carries the title", () => {
    render(
      <HtmlModeToggle
        mode="source"
        onChange={() => {}}
        renderDisabled
        renderDisabledReason="File too large to render"
      />,
    );
    const renderedBtn = screen.getByRole("button", { name: "Rendered" });
    expect(renderedBtn).toBeDisabled();
    expect(renderedBtn).toHaveAttribute("title", "File too large to render");
    expect(screen.getByRole("button", { name: "Source" })).not.toBeDisabled();
  });
});
