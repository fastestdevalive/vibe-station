import type { InstallProgress, InstallStage } from "@/api/types";

/** Pipeline order; the single source for labels, percent and any stage list. */
export const INSTALL_STAGES: readonly InstallStage[] = [
  "preflight",
  "downloading",
  "verifying",
  "installing",
];

/** One stage → label mapping shared by the chip, dialog and Settings. */
export function installLabel(p: InstallProgress): string {
  switch (p.stage) {
    case "preflight":
      return "Checking prerequisites…";
    case "downloading":
      return `Downloading… ${p.pct}%`;
    case "verifying":
      return "Verifying checksum…";
    case "installing":
      return "Installing…";
  }
}

/** Progress never goes backwards: only preflight/downloading report their own pct. */
export function installPct(p: InstallProgress): number {
  return p.stage === "preflight" || p.stage === "downloading" ? p.pct : 100;
}
