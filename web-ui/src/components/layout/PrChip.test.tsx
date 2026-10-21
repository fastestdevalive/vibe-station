import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrStatus } from "@/api/types";

const openExternal = vi.fn();
vi.mock("@/lib/openExternal", () => ({ openExternal: (u: string) => openExternal(u) }));

import { PrChip } from "./PrChip";

const pr = (over: Partial<PrStatus> = {}): PrStatus => ({
  state: "open",
  number: 142,
  url: "https://github.com/acme/repo/pull/142",
  checkedAt: "2026-10-21T00:00:00Z",
  ...over,
});

describe("PrChip (4.T4)", () => {
  beforeEach(() => openExternal.mockClear());

  it("renders icon + '#142' only; the state lives in the aria-label", () => {
    render(<PrChip pr={pr()} />);
    const chip = screen.getByRole("link");
    expect(chip.textContent).toBe("#142");
    expect(chip.querySelector("svg")).not.toBeNull();
    expect(chip.getAttribute("aria-label")).toBe("Open pull request #142 (open)");
  });

  it("strikes through the number when closed", () => {
    const { container } = render(<PrChip pr={pr({ state: "closed" })} />);
    expect(container.querySelector(".pr-chip--closed .pr-chip__num")).not.toBeNull();
  });

  it("opens the PR on click without activating the parent anchor", () => {
    const parentClick = vi.fn((e: React.MouseEvent) => e.preventDefault());
    render(
      <a href="/worktree/w1" onClick={parentClick}>
        <PrChip pr={pr()} />
      </a>,
    );
    fireEvent.click(screen.getByText("#142").closest('[role="link"]') as HTMLElement);
    expect(openExternal).toHaveBeenCalledWith("https://github.com/acme/repo/pull/142");
    expect(parentClick).not.toHaveBeenCalled();
  });

  it("activates on Enter", () => {
    render(<PrChip pr={pr()} />);
    fireEvent.keyDown(screen.getByRole("link"), { key: "Enter" });
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it("renders nothing for state 'none' or a missing url/number", () => {
    const { container, rerender } = render(<PrChip pr={pr({ state: "none" })} />);
    expect(container.firstChild).toBeNull();
    rerender(<PrChip pr={pr({ url: undefined })} />);
    expect(container.firstChild).toBeNull();
    rerender(<PrChip pr={null} />);
    expect(container.firstChild).toBeNull();
  });
});
