import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Mode, SupportedCli } from "@/api/types";
import { ModeIcon } from "@/components/agent/ModeIcon";

interface CliDetectionPanelProps {
  api: ApiInstance;
  /** `"oobe"` renders inside the onboarding flow; `"settings"` is purely
   *  additive/informational and must not block or disable any other control. */
  variant: "oobe" | "settings";
  /**
   * Bump this (e.g. a counter) whenever a SIBLING action outside this
   * component may have changed detection/bundle state — most importantly
   * `OobeStep2Modes`'s own `detectAndBundleOobe()` call on mount/Re-check.
   * Without this, this panel's own independent `getSupportedClis()` fetch
   * races that sibling call (both fire around the same time, uncoordinated),
   * so the detected/fallback badges can read stale until some UNRELATED mode
   * WS event happens to trigger a refetch. Optional: `variant="settings"`
   * has no sibling bundle-triggering action, so it never needs this.
   */
  refreshSignal?: number;
}

export function CliDetectionPanel({ api, variant, refreshSignal }: CliDetectionPanelProps) {
  const [supportedClis, setSupportedClis] = useState<SupportedCli[]>([]);
  const [modes, setModes] = useState<Mode[]>([]);

  useEffect(() => {
    void api.getSupportedClis().then(setSupportedClis);
    void api.listModes().then(setModes);
  }, [api, refreshSignal]);

  useEffect(() => {
    const offCreated = api.on("mode:created", () => {
      void api.listModes().then(setModes);
    });
    const offUpdated = api.on("mode:updated", () => {
      void api.listModes().then(setModes);
    });
    const offDeleted = api.on("mode:deleted", () => {
      void api.listModes().then(setModes);
    });
    return () => {
      offCreated();
      offUpdated();
      offDeleted();
    };
  }, [api]);

  async function createBundle(cli: SupportedCli) {
    await api.createStarterBundle(cli.id);
    const [nextModes, nextClis] = await Promise.all([api.listModes(), api.getSupportedClis()]);
    setModes(nextModes);
    setSupportedClis(nextClis);
  }

  return (
    <div
      data-variant={variant}
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
    >
      {supportedClis.map((cli) => {
        const missingCount = cli.starterBundleNames.filter(
          (name) => !modes.some((m) => m.cli === cli.id && m.name === name),
        ).length;
        const total = cli.starterBundleNames.length;
        return (
          <div
            key={cli.id}
            data-testid={`cli-row-${cli.id}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-3)",
              padding: "var(--space-3)",
              borderRadius: "var(--radius-sm)",
              border: cli.detected
                ? "var(--border-width) solid var(--fg-success)"
                : "var(--border-width) solid var(--border-default)",
              opacity: cli.detected ? 1 : 0.6,
            }}
          >
            <span aria-hidden="true" style={{ display: "inline-flex" }}>
              <ModeIcon iconKey={cli.id} channel="json" size={18} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                <span style={{ fontWeight: 500, color: "var(--fg-primary)" }}>{cli.id}</span>
                <span
                  data-testid={`cli-detected-${cli.id}`}
                  style={{
                    fontSize: "11px",
                    fontWeight: "var(--font-weight-medium)",
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: cli.detected ? "var(--bg-input)" : "transparent",
                    border: cli.detected
                      ? "var(--border-width) solid var(--fg-success)"
                      : "var(--border-width) solid var(--border-default)",
                    color: cli.detected ? "var(--fg-success)" : "var(--fg-muted)",
                  }}
                >
                  {cli.detected ? "✓ detected" : "✘ not found"}
                </span>
              </div>
              {!cli.detected && (
                <div style={{ marginTop: 4, fontSize: "var(--font-size-xs)", color: "var(--fg-secondary)" }}>
                  Install with your package manager, then re-check.
                </div>
              )}
              {cli.usingFallbackOnly && (
                <div style={{ marginTop: 4, fontSize: "var(--font-size-xs)", color: "var(--fg-secondary)" }}>
                  Using a generic fallback mode — model discovery didn&apos;t succeed for the named bundle.
                </div>
              )}
            </div>
            {cli.detected && (
              <div style={{ display: "flex", alignItems: "center" }}>
                {missingCount === 0 ? (
                  <span
                    data-testid={`cli-all-created-${cli.id}`}
                    style={{ fontSize: "13px", color: "var(--fg-muted)" }}
                  >
                    ✓ all created
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void createBundle(cli)}
                    style={{
                      background: "var(--bg-input)",
                      border: "var(--border-width) solid var(--border-default)",
                      borderRadius: 6,
                      padding: "6px 12px",
                      cursor: "pointer",
                      fontSize: "13px",
                      color: "var(--fg-primary)",
                    }}
                  >
                    {missingCount === total ? "Create starter modes" : `Recreate ${missingCount}`}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
