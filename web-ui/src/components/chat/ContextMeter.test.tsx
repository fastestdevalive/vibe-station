import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { UsageInfo } from "@/api/types";
import { ContextMeter } from "./ContextMeter";

function usage(total: number, contextWindow?: number): UsageInfo {
  return {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    totalTokens: total,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    // A cost on the payload must never reach the UI.
    costUsd: 0.142,
    model: "sonnet",
  };
}

describe("ContextMeter", () => {
  it("renders nothing without usage", () => {
    const { container } = render(<ContextMeter usage={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a fill bar and compact used / window text", () => {
    const { container } = render(<ContextMeter usage={usage(18_240, 200_000)} />);
    const meter = screen.getByRole("meter", { name: "Context window used" });
    expect(meter.getAttribute("aria-valuenow")).toBe("9");
    expect(meter.textContent).toBe("18.2k / 200k (9%)");
    expect((container.querySelector(".ctx-meter__fill") as HTMLElement).style.width).toBe("9%");
    expect(meter.className).toBe("ctx-meter");
    expect(meter.getAttribute("title")).toContain("18,240 / 200,000");
  });

  it("stays theme-coloured below 80%, orange from 80%, red from 90%", () => {
    const cls = (n: number) => render(<ContextMeter usage={usage(n, 100)} />).container.firstElementChild!.className;
    expect(cls(79)).toBe("ctx-meter");
    expect(cls(80)).toContain("ctx-meter--warn");
    expect(cls(89)).toContain("ctx-meter--warn");
    expect(cls(90)).toContain("ctx-meter--danger");
  });

  it("caps the fill at 100%", () => {
    const { container } = render(<ContextMeter usage={usage(250_000, 200_000)} />);
    expect((container.querySelector(".ctx-meter__fill") as HTMLElement).style.width).toBe("100%");
  });

  it("without a context window shows only the token count (no bar, no meter role)", () => {
    const { container } = render(<ContextMeter usage={usage(1_250_000)} />);
    expect(container.querySelector(".ctx-meter__bar")).toBeNull();
    expect(screen.queryByRole("meter")).toBeNull();
    expect(container.textContent).toBe("1.3M");
  });

  it("shows the percentage as text in parentheses next to the count", () => {
    const { container } = render(<ContextMeter usage={usage(100_000, 200_000)} />);
    expect(container.querySelector(".ctx-meter__pct")!.textContent).toBe(" (50%)");
    // No window known -> no percentage to show.
    expect(render(<ContextMeter usage={usage(5_000)} />).container.querySelector(".ctx-meter__pct")).toBeNull();
  });

  it("never renders cost", () => {
    const { container } = render(<ContextMeter usage={usage(18_240, 200_000)} />);
    expect(container.textContent).not.toMatch(/\$|0\.142/);
  });
});
