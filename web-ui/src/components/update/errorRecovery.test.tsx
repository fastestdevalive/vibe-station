import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/errors";
import type { UpdateError, UpdateReason, UpdateStatus } from "@/api/types";
import { InstallRecoveryActions, actionErrorCopy, recoveryFor } from "./errorRecovery";

const STATUS: UpdateStatus = {
  current: "1.0.0",
  latest: "1.2.3",
  behindCount: 1,
  updateAvailable: true,
  skipped: [],
  installMethod: "curl",
  targets: [{ method: "curl", path: "/opt/vst/bin/vst", auto: true }],
  autoCheck: true,
  platform: "linux-x86_64",
  noAsset: false,
  releaseUrl: "https://example.test/release/v1.2.3",
};

function renderActions(error: UpdateError) {
  render(
    <InstallRecoveryActions
      status={{ ...STATUS, lastError: error }}
      error={error}
      canInstall
      busy={false}
      onRetry={() => {}}
    />,
  );
}

describe("recovery per reason", () => {
  it("permission_denied: sudo copy block, no Retry", () => {
    renderActions({
      kind: "install",
      reason: "permission_denied",
      message: "cannot write to /opt/vst/bin: Permission denied",
    });
    expect(screen.getByRole("button", { name: "Copy code to clipboard" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it.each<UpdateReason>([
    "missing_checksum",
    "missing_signature",
    "bad_signature",
    "downgrade",
    "checksum_mismatch",
    "smoke_failed",
  ])("%s: Retry plus View release, verification copy", (reason) => {
    const error: UpdateError = { kind: "install", reason, message: "raw" };
    expect(recoveryFor(error).message).toBe("Download failed verification. Nothing was changed.");
    renderActions(error);
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "View release" })).toHaveAttribute(
      "href",
      STATUS.releaseUrl,
    );
  });

  it.each<UpdateReason>(["github_error", "offline"])(
    "%s: Couldn't reach GitHub, Retry, no View release, raw message as detail",
    (reason) => {
      const error: UpdateError = {
        kind: "install",
        reason,
        message: "SHA256SUMS.minisig returned HTTP 500",
      };
      const r = recoveryFor(error);
      expect(r.message).toBe("Couldn't reach GitHub.");
      expect(r.detail).toBe("SHA256SUMS.minisig returned HTTP 500");
      renderActions(error);
      expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
      expect(screen.queryByRole("link", { name: "View release" })).toBeNull();
    },
  );

  it("no_asset: View release only", () => {
    renderActions({ kind: "install", reason: "no_asset", message: "x" });
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(screen.getByRole("link", { name: "View release" })).toBeInTheDocument();
  });

  it("disk_full: Retry after freeing space", () => {
    const error: UpdateError = { kind: "install", reason: "disk_full", message: "No space left." };
    expect(recoveryFor(error).message).toContain("Retry after freeing space");
    renderActions(error);
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("rate_limited with retryAfter in the future: Retry disabled", () => {
    renderActions({
      kind: "install",
      reason: "rate_limited",
      message: "slow down",
      retryAfter: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
  });
});

describe("actionErrorCopy on real ApiError shapes", () => {
  it("maps daemon error codes", () => {
    expect(actionErrorCopy(new ApiError("not_cancellable", 409, "not_cancellable"))).toMatch(
      /Too late to cancel/,
    );
    expect(actionErrorCopy(new ApiError("No update is available", 422, "no_asset"))).toMatch(
      /No prebuilt/,
    );
    expect(actionErrorCopy(new ApiError("mobile_read_only", 403, "mobile_read_only"))).toMatch(
      /computer/,
    );
  });

  it("network failure is not silent", () => {
    expect(actionErrorCopy(new TypeError("Failed to fetch"))).toMatch(/Failed to fetch/);
  });
});
