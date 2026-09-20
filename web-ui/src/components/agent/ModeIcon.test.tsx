import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ModeIcon } from "./ModeIcon";

describe("ModeIcon (2.T1 — keys, fallback, terminal frame)", () => {
  it("renders an inline SVG glyph for each known key", () => {
    for (const key of ["claude", "agy", "opencode", "deepseek", "cursor"]) {
      const { container } = render(<ModeIcon iconKey={key} channel="json" />);
      expect(container.querySelector("svg")).toBeInTheDocument();
      expect(container.querySelector(".mode-icon__glyph--fallback")).toBeNull();
    }
  });

  it("renders the generic fallback glyph for an unknown key", () => {
    const { container } = render(<ModeIcon iconKey="nope" channel="json" />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector(".mode-icon__glyph--fallback")).toHaveTextContent("◈");
  });

  it("renders the generic fallback glyph for a null/undefined icon key", () => {
    expect(render(<ModeIcon iconKey={null} />).container.querySelector(".mode-icon__glyph--fallback")).toHaveTextContent("◈");
    expect(render(<ModeIcon />).container.querySelector(".mode-icon__glyph--fallback")).toHaveTextContent("◈");
  });

  it("terminal channels (pty/tmux/undefined) add the terminal frame, json does not", () => {
    expect(render(<ModeIcon iconKey="claude" channel="pty" />).container.querySelector(".mode-icon--terminal")).not.toBeNull();
    expect(render(<ModeIcon iconKey="claude" channel="tmux" />).container.querySelector(".mode-icon--terminal")).not.toBeNull();
    expect(render(<ModeIcon iconKey="claude" />).container.querySelector(".mode-icon--terminal")).not.toBeNull();
    expect(render(<ModeIcon iconKey="claude" channel="json" />).container.querySelector(".mode-icon--terminal")).toBeNull();
  });

  it("terminal frame includes the title-bar dots", () => {
    const { container } = render(<ModeIcon iconKey="opencode" channel="pty" />);
    expect(container.querySelectorAll(".mode-icon__dot")).toHaveLength(3);
  });

  it("exposes an accessible label and title", () => {
    const { getByLabelText } = render(<ModeIcon iconKey="deepseek" channel="json" />);
    expect(getByLabelText("deepseek")).toBeInTheDocument();
  });

  it("applies the size prop to the glyph", () => {
    const { container } = render(<ModeIcon iconKey="cursor" channel="json" size={18} />);
    const glyph = container.querySelector(".mode-icon__glyph");
    expect(glyph).toHaveStyle("width: 18px");
    expect(glyph).toHaveStyle("height: 18px");
  });

  it("treats inherited object keys as unknown (fallback glyph, not function source)", () => {
    const { container } = render(<ModeIcon iconKey="constructor" channel="json" />);
    expect(container.querySelector(".mode-icon__glyph--fallback")?.textContent).toBe("◈");
  });
});
