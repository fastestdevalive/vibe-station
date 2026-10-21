import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { createMockApi } from "@/api/mock";
import type { DoctorReport } from "@/api/types";
import { DoctorSetting } from "./DoctorSetting";

describe("DoctorSetting summary", () => {
  it("does not claim all checks pass when an optional check warns", async () => {
    const api = createMockApi();
    const report: DoctorReport = {
      hardOk: true,
      ok: true,
      featureOk: true,
      hostOs: "linux",
      hostname: "h",
      checkedAt: "2026-01-01T00:00:00Z",
      checks: [
        { name: "git", status: "ok", required: true, group: "required", message: "", resolvedPath: null, installHint: null },
        { name: "plug", status: "warn", required: false, group: "optional", message: "meh", resolvedPath: null, installHint: null },
      ],
    };
    api.getDoctorReport = async () => report;
    render(<DoctorSetting api={api} />);
    expect(await screen.findByText(/1 optional item needs attention/)).toBeInTheDocument();
    expect(screen.queryByText(/All checks passing/)).toBeNull();
  });
});
