import { describe, it, expect } from "vitest";
import type { InstallStage } from "@/api/types";
import { installLabel, installPct } from "./installProgress";

const p = (stage: InstallStage, pct: number) => ({ stage, pct, startedBy: "ui" as const });

describe("installProgress", () => {
  it("pins pct to 100 once past the download", () => {
    expect(installPct(p("installing", 0))).toBe(100);
    expect(installPct(p("verifying", 100))).toBe(100);
    expect(installPct(p("downloading", 42))).toBe(42);
    expect(installPct(p("preflight", 0))).toBe(0);
  });

  it("labels every stage", () => {
    expect(installLabel(p("preflight", 0))).toBe("Checking prerequisites…");
    expect(installLabel(p("downloading", 42))).toBe("Downloading… 42%");
    expect(installLabel(p("verifying", 100))).toBe("Verifying checksum…");
    expect(installLabel(p("installing", 0))).toBe("Installing…");
  });
});
