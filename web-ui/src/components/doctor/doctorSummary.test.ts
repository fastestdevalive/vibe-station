import { describe, it, expect } from "vitest";
import type { DoctorCheckDto } from "@/api/types";
import { doctorSummary } from "./doctorSummary";

const chk = (
  name: string,
  status: DoctorCheckDto["status"],
  group: DoctorCheckDto["group"] = "optional",
): DoctorCheckDto => ({
  name,
  status,
  required: group === "required",
  group,
  message: "",
  resolvedPath: null,
  installHint: null,
});

describe("doctorSummary", () => {
  it("every check OK → ok tone", () => {
    const s = doctorSummary([chk("git", "ok", "required"), chk("gh", "ok")]);
    expect(s.tone).toBe("ok");
    expect(s.text).toBe("All checks pass.");
    expect(s.counts).toEqual({ missing: 0, warnings: 0 });
  });

  it("required OK with 2 errors and 6 warnings → attention", () => {
    const checks = [
      chk("git", "ok", "required"),
      ...["a", "b"].map((n) => chk(n, "error")),
      ...["c", "d", "e", "f", "g", "h"].map((n) => chk(n, "warn")),
    ];
    const s = doctorSummary(checks);
    expect(s.tone).toBe("attention");
    expect(s.text).toBe("All required checks pass. 8 optional items need attention.");
    expect(s.counts).toEqual({ missing: 2, warnings: 6 });
  });

  it("singular optional item", () => {
    expect(doctorSummary([chk("x", "warn")]).text).toBe(
      "All required checks pass. 1 optional item needs attention.",
    );
  });

  it("tmux error → fail", () => {
    const s = doctorSummary([chk("tmux", "error", "required"), chk("git", "ok", "required")]);
    expect(s.tone).toBe("fail");
    expect(s.text).toBe("1 required check failing.");
  });
});
