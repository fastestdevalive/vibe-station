import { describe, it, expect } from "vitest";
import type { UpdateStatus } from "@/api/types";
import {
  chipView,
  dialogState,
  dialogTitle,
  formatVersion,
  isInstalledDone,
  isLatestSkipped,
  restartPendingIsLatest,
  rolledBackRetry,
} from "./updateView";

const BASE: UpdateStatus = {
  current: "1.0.0",
  behindCount: 0,
  updateAvailable: false,
  skipped: [],
  installMethod: "curl",
  targets: [],
  autoCheck: true,
  platform: "linux-x86_64",
  noAsset: false,
};
const OFFER: UpdateStatus = { ...BASE, updateAvailable: true, latest: "1.2.3" };
const RESULT = { version: "1.2.3", updated: ["/bin/vst"], manual: [] };

describe("formatVersion", () => {
  it("always shows release versions with a v prefix and dev builds verbatim", () => {
    expect(formatVersion("1.2.3")).toBe("v1.2.3");
    expect(formatVersion("v1.2.3")).toBe("v1.2.3");
    expect(formatVersion("1.2.3-rc.1")).toBe("v1.2.3-rc.1");
    expect(formatVersion("dev")).toBe("dev");
    expect(formatVersion("")).toBe("");
  });
});

describe("chipView priority", () => {
  const cases: Array<[string, UpdateStatus, string | null]> = [
    ["nothing to show", BASE, null],
    ["update available", OFFER, "available"],
    [
      "rolled back beats available",
      { ...OFFER, rolledBack: { failedVersion: "1.2.3", at: "t" } as UpdateStatus["rolledBack"] },
      "rolled-back",
    ],
    [
      "restart pending beats rolled back",
      {
        ...OFFER,
        rolledBack: { failedVersion: "1.2.3", at: "t" } as UpdateStatus["rolledBack"],
        restartPending: { kind: "daemon", version: "1.2.3" },
      },
      "restart",
    ],
    [
      "installing beats restart pending",
      {
        ...OFFER,
        restartPending: { kind: "daemon", version: "1.2.3" },
        install: { stage: "downloading", pct: 5, startedBy: "ui" },
      },
      "installing",
    ],
  ];
  it.each(cases)("%s", (_name, status, state) => {
    expect(chipView(status, true, null)?.state ?? null).toBe(state);
  });

  it("hides the available chip for a skipped, reminded or installed-elsewhere version only", () => {
    expect(chipView({ ...OFFER, skipped: ["1.2.3"] }, true, null)).toBeNull();
    expect(chipView(OFFER, true, "1.2.3")).toBeNull();
    expect(chipView(OFFER, true, "1.2.4")?.state).toBe("available");
    expect(chipView({ ...OFFER, lastResult: RESULT }, true, null)).toBeNull();
  });

  it("offers the inline skip button only to installers, and labels versions with a v", () => {
    expect(chipView(OFFER, true, null)).toMatchObject({ showSkip: true, label: "Update v1.2.3" });
    expect(chipView(OFFER, false, null)?.showSkip).toBe(false);
  });

  it("shows a stage label, never a backwards 0%, before the download starts", () => {
    const view = chipView({ ...OFFER, install: { stage: "installing", pct: 0, startedBy: "ui" } }, true, null);
    expect(view?.label).not.toContain("0%");
  });
});

describe("status predicates", () => {
  it("rolledBackRetry only when the failed version is the one on offer", () => {
    const rb = { failedVersion: "1.2.3", at: "t" } as UpdateStatus["rolledBack"];
    expect(rolledBackRetry({ ...OFFER, rolledBack: rb })).toBe(true);
    expect(rolledBackRetry({ ...OFFER, latest: "1.3.0", rolledBack: rb })).toBe(false);
    expect(rolledBackRetry(OFFER)).toBe(false);
  });

  it("isLatestSkipped, restartPendingIsLatest and isInstalledDone", () => {
    expect(isLatestSkipped({ ...OFFER, skipped: ["1.2.3"] })).toBe(true);
    expect(isLatestSkipped(OFFER)).toBe(false);
    expect(restartPendingIsLatest({ ...OFFER, restartPending: { kind: "daemon", version: "1.2.3" } })).toBe(true);
    expect(isInstalledDone({ ...OFFER, lastResult: RESULT })).toBe(true);
    expect(isInstalledDone({ ...OFFER, lastResult: { ...RESULT, manual: [{ kind: "text", text: "x" }] } })).toBe(false);
  });
});

describe("dialogState order", () => {
  it("picks the first matching state", () => {
    const err = { kind: "install", reason: "offline", message: "m" } as UpdateStatus["lastError"];
    expect(dialogState({ ...OFFER, noAsset: true, install: { stage: "preflight", pct: 0, startedBy: "ui" } })).toBe("no_asset");
    expect(dialogState({ ...OFFER, install: { stage: "preflight", pct: 0, startedBy: "ui" } })).toBe("installing");
    expect(dialogState({ ...OFFER, restartPending: { kind: "app", version: "1.2.3" } })).toBe("restart_pending");
    expect(dialogState({ ...OFFER, lastResult: { ...RESULT, manual: [{ kind: "text", text: "x" }] } })).toBe("manual");
    expect(dialogState({ ...OFFER, lastResult: RESULT })).toBe("done");
    expect(dialogState({ ...OFFER, lastError: err })).toBe("error");
    expect(dialogState(OFFER)).toBe("available");
  });

  it("titles each state with a v-prefixed version", () => {
    expect(dialogTitle(OFFER)).toBe("vibe-station v1.2.3 available");
    expect(dialogTitle({ ...OFFER, lastResult: RESULT })).toBe("v1.2.3 installed");
    expect(dialogTitle({ ...OFFER, install: { stage: "preflight", pct: 0, startedBy: "ui" } })).toBe("Updating to v1.2.3");
  });
});
