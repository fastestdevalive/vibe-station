import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { StatusDot } from "./StatusDot";
import type { PrStatus } from "@/api/types";

function pr(state: PrStatus["state"], prBranch = "feature-x"): PrStatus {
  return { state, checkedAt: "2026-08-16T00:00:00.000Z", prBranch };
}

describe("StatusDot (5.T5 — one indicator, D17/D18)", () => {
  it("waiting_for_human + pr=open renders the round ● dot with the pr-open class, not the waiting !", () => {
    const { container, getByLabelText } = render(<StatusDot status="waiting_for_human" pr={pr("open")} />);
    const dot = container.querySelector(".status-dot");
    expect(dot).toHaveClass("status-dot--pr-open");
    expect(dot).toHaveTextContent("●");
    // title/aria-label name the resolved state so it isn't colour-only.
    expect(getByLabelText("status: pr-open")).toBeInTheDocument();
    expect(dot).toHaveAttribute("title", "pr-open");
  });

  it("waiting_for_human with no PR keeps the shape-distinct red ! and its own class", () => {
    const { container, getByLabelText } = render(<StatusDot status="waiting_for_human" pr={null} />);
    const dot = container.querySelector(".status-dot");
    expect(dot).toHaveClass("status-dot--waiting_for_human");
    expect(dot).toHaveTextContent("!");
    expect(getByLabelText("status: waiting_for_human")).toBeInTheDocument();
  });

  it("working renders ● with the working class", () => {
    const { container } = render(<StatusDot status="working" pr={null} />);
    const dot = container.querySelector(".status-dot");
    expect(dot).toHaveClass("status-dot--working");
    expect(dot).toHaveTextContent("●");
  });

  it("pr=merged renders ● with the pr-merged class even when lifecycle is idle", () => {
    const { container } = render(<StatusDot status="idle" pr={pr("merged")} />);
    const dot = container.querySelector(".status-dot");
    expect(dot).toHaveClass("status-dot--pr-merged");
    expect(dot).toHaveTextContent("●");
  });

  it("done/idle/exited stay neutral glyphs when there is no PR", () => {
    expect(render(<StatusDot status="done" pr={null} />).container.querySelector(".status-dot")).toHaveTextContent(
      "✓",
    );
    expect(render(<StatusDot status="idle" pr={null} />).container.querySelector(".status-dot")).toHaveTextContent(
      "○",
    );
    expect(
      render(<StatusDot status="exited" pr={null} />).container.querySelector(".status-dot"),
    ).toHaveTextContent("×");
  });

  it("pr defaults to null when omitted, matching callers that never track a PR", () => {
    const { container } = render(<StatusDot status="idle" />);
    expect(container.querySelector(".status-dot")).toHaveClass("status-dot--idle");
  });

  it("B1 — done + an open/merged PR keeps the ✓ glyph, not the recoloured ● (terminal glyph survives recolour)", () => {
    const openDot = render(<StatusDot status="done" pr={pr("open")} />).container.querySelector(".status-dot");
    expect(openDot).toHaveClass("status-dot--pr-open");
    expect(openDot).toHaveTextContent("✓");

    const mergedDot = render(<StatusDot status="done" pr={pr("merged")} />).container.querySelector(".status-dot");
    expect(mergedDot).toHaveClass("status-dot--pr-merged");
    expect(mergedDot).toHaveTextContent("✓");
  });

  it("B1 — exited + an open/merged PR keeps the × glyph, not the recoloured ●", () => {
    const openDot = render(<StatusDot status="exited" pr={pr("open")} />).container.querySelector(".status-dot");
    expect(openDot).toHaveClass("status-dot--pr-open");
    expect(openDot).toHaveTextContent("×");

    const mergedDot = render(<StatusDot status="exited" pr={pr("merged")} />).container.querySelector(
      ".status-dot",
    );
    expect(mergedDot).toHaveClass("status-dot--pr-merged");
    expect(mergedDot).toHaveTextContent("×");
  });
});
