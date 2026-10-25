import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BulkRowTrail } from "./BulkRowTrail";

describe("BulkRowTrail", () => {
  it("select mode: trail carries bulk-row__trail, order chip -> diffstat -> checkbox", () => {
    const { container } = render(
      <BulkRowTrail
        label="wt"
        checked={false}
        running
        diffStat={<span data-testid="diff">+1</span>}
        onToggle={vi.fn()}
      />,
    );
    const trail = container.firstElementChild as HTMLElement;
    expect(trail).toHaveClass("wt-row__trail", "bulk-row__trail");
    const kids = Array.from(trail.children);
    expect(kids[0]).toHaveClass("bulk-row__chip");
    expect(kids[1]).toHaveAttribute("data-testid", "diff");
    expect(kids[2]).toHaveClass("bulk-row__checkbox");
  });

  it("job status mode: trail carries bulk-row__trail, order chip -> diffstat -> status", () => {
    const { container } = render(
      <BulkRowTrail
        label="wt"
        checked={null}
        running
        diffStat={<span data-testid="diff">+1</span>}
        jobStatus="running"
        jobAction="delete"
        onToggle={vi.fn()}
      />,
    );
    const trail = container.firstElementChild as HTMLElement;
    expect(trail).toHaveClass("bulk-row__trail");
    const kids = Array.from(trail.children);
    expect(kids[0]).toHaveClass("bulk-row__chip");
    expect(kids[1]).toHaveAttribute("data-testid", "diff");
    expect(kids[2]).toHaveClass("bulk-row__status");
  });
});
