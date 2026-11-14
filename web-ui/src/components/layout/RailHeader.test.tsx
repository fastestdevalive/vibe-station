import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RailHeader } from "./RailHeader";

// The hosts are context-bound; the header's contract is only "the host is the last child", so stub them.
vi.mock("@/components/layout/TopActionsSlot", () => ({
  ModeHeaderActionsHost: ({ mode }: { mode: string }) => <span data-testid="host">mode:{mode}</span>,
  ToolActionsHost: () => <span data-testid="host">tool</span>,
}));

describe("RailHeader", () => {
  it("renders left, spacer, right, then the mode host last, with the 35px row class and height", () => {
    const { container } = render(
      <RailHeader mode="artifacts" className="artifacts-head" left={<span>Title</span>} right={<span>Right</span>} />,
    );
    const row = container.firstElementChild as HTMLElement;
    expect(row).toHaveClass("actions-row", "rail-header", "artifacts-head");
    expect(row.style.height).toBe("var(--pane-row-h)");
    const kids = Array.from(row.children);
    expect(kids[0]).toHaveClass("rail-header__left");
    expect(kids[0]).toHaveTextContent("Title");
    expect(kids[1]).toHaveClass("rail-header__sp");
    expect(kids[2]).toHaveClass("rail-header__right");
    expect(kids[3]).toHaveTextContent("mode:artifacts");
    expect(kids).toHaveLength(4);
  });

  it("host='tool' ends with the plain tool host instead of the mode host", () => {
    const { container } = render(<RailHeader left="Commits" host="tool" />);
    const row = container.firstElementChild as HTMLElement;
    const last = row.lastElementChild as HTMLElement;
    expect(last).toHaveTextContent("tool");
    expect(last).not.toHaveTextContent("mode:");
  });

  it("omits the right zone when no right content is passed", () => {
    const { container } = render(<RailHeader mode="tree" left="Files" />);
    expect(container.querySelector(".rail-header__right")).toBeNull();
  });
});
