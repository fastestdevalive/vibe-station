import type { DoctorCheckDto } from "@/api/types";

export interface DoctorSummary {
  tone: "ok" | "attention" | "fail";
  text: string;
  counts: { missing: number; warnings: number };
}

/** One-line verdict shared by onboarding step 3 and Settings → Doctor. */
export function doctorSummary(checks: DoctorCheckDto[]): DoctorSummary {
  const failing = checks.filter((c) => c.status !== "ok");
  const requiredFailing = failing.filter((c) => c.group === "required" && c.status !== "timeout").length;
  const missing = failing.filter((c) => c.status === "error").length;
  const warnings = failing.filter((c) => c.status === "warn" || c.status === "timeout").length;
  const optionalAttention = failing.length - requiredFailing;
  const counts = { missing, warnings };

  if (requiredFailing > 0) {
    return {
      tone: "fail",
      text: `${requiredFailing} required check${requiredFailing === 1 ? "" : "s"} failing.`,
      counts,
    };
  }
  if (optionalAttention > 0) {
    return {
      tone: "attention",
      text: `All required checks pass. ${optionalAttention} optional item${optionalAttention === 1 ? " needs" : "s need"} attention.`,
      counts,
    };
  }
  return { tone: "ok", text: "All checks pass.", counts };
}
