import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Mode, SupportedCli } from "@/api/types";
import { ModeIcon } from "@/components/agent/ModeIcon";
import { Select } from "@/components/ui/Select";
import { cliDisplayName } from "@/lib/cliNames";

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
  // { [cliId]: message } — a failed default-channel PATCH (400 validation,
  // network error) otherwise fails silently and leaves the select looking
  // like nothing happened (round-3 m3).
  const [channelErrors, setChannelErrors] = useState<Record<string, string>>({});
  const [bundleErrors, setBundleErrors] = useState<Record<string, string>>({});
  const [bundleBusy, setBundleBusy] = useState<Set<string>>(new Set());
  // CLI ids with a default-channel PATCH in flight — disables that row's
  // select so a second change can't race the first's refetch (round-3 m3).
  const [pendingChannelChanges, setPendingChannelChanges] = useState<Set<string>>(new Set());

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
    setBundleBusy((prev) => new Set(prev).add(cli.id));
    try {
      const res = await api.createStarterBundle(cli.id);
      setBundleErrors((prev) => ({ ...prev, [cli.id]: res.modelsError ?? "" }));
    } catch (e) {
      setBundleErrors((prev) => ({
        ...prev,
        [cli.id]: e instanceof Error ? e.message : "Couldn't create the starter modes.",
      }));
    }
    // Refetch BEFORE clearing busy so the button can't reappear enabled (and be
    // double-clicked) in the gap between create finishing and modes reloading.
    try {
      const [nextModes, nextClis] = await Promise.all([api.listModes(), api.getSupportedClis()]);
      setModes(nextModes);
      setSupportedClis(nextClis);
    } catch {
      // Keep the previous lists; the mode:* WS handlers will refresh them.
    } finally {
      setBundleBusy((prev) => {
        const next = new Set(prev);
        next.delete(cli.id);
        return next;
      });
    }
  }

  return (
    <div
      data-variant={variant}
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
    >
      {supportedClis.map((cli) => {
        const hasAnyMode = modes.some((m) => m.cli === cli.id);
        // Default-channel toggle state (settings variant only). The effective
        // `defaultChannel` is one of the two options; whichever one is the
        // plugin's OWN default (the other option when `defaultChannelOverridden`
        // is true — the daemon reports that flag as "effective value differs
        // from the plugin's own default", not merely "a key exists") carries
        // the "(built-in)" label and, when selected, CLEARS the override (null).
        const current: "json" | "tmux" = cli.defaultChannel === "tmux" ? "tmux" : "json";
        const other: "json" | "tmux" = current === "json" ? "tmux" : "json";
        const defaultOption: "json" | "tmux" = cli.defaultChannelOverridden ? other : current;
        const onChannelChange = (value: "json" | "tmux") => {
          const payload = value === defaultOption ? null : value;
          setChannelErrors((prev) => ({ ...prev, [cli.id]: "" }));
          setPendingChannelChanges((prev) => new Set(prev).add(cli.id));
          void api
            .updateSettings({ defaultChannelByCli: { [cli.id]: payload } })
            .then(() => api.getSupportedClis().then(setSupportedClis))
            .catch((err: unknown) => {
              setChannelErrors((prev) => ({
                ...prev,
                [cli.id]: err instanceof Error ? err.message : "Couldn't update the default channel.",
              }));
            })
            .finally(() => {
              setPendingChannelChanges((prev) => {
                const next = new Set(prev);
                next.delete(cli.id);
                return next;
              });
            });
        };
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
              border: "var(--border-width) solid var(--border-default)",
              opacity: cli.detected ? 1 : 0.6,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flex: 1, minWidth: 0 }}>
              <span aria-hidden="true" style={{ display: "inline-flex", flexShrink: 0 }}>
                <ModeIcon iconKey={cli.id} channel="json" size={18} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <span style={{ fontWeight: 500, color: "var(--fg-primary)" }}>{cliDisplayName(cli.id)}</span>
                </div>
                {bundleErrors[cli.id] ? (
                  <div
                    data-testid={`bundle-error-${cli.id}`}
                    style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-danger, #ef4444)" }}
                  >
                    {bundleErrors[cli.id]}
                  </div>
                ) : null}
                <div style={{ marginTop: 4 }}>
                  <span
                    data-testid={`cli-detected-${cli.id}`}
                    style={{
                      fontSize: "11px",
                      fontWeight: "var(--font-weight-medium)",
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
            </div>
            {cli.detected && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  flexShrink: 0,
                }}
              >
                {!hasAnyMode ? (
                  // No mode exists for THIS CLI yet — offer to create the
                  // starter bundle. Mutually exclusive with the default-channel
                  // select (other branch): once a mode exists, that slot carries the
                  // dropdown instead (settings) or the confirmation label (oobe).
                  <button
                    type="button"
                    onClick={() => void createBundle(cli)}
                    disabled={bundleBusy.has(cli.id)}
                    style={{
                      background: "var(--bg-input)",
                      border: "var(--border-width) solid var(--border-default)",
                      borderRadius: 6,
                      padding: "6px 12px",
                      cursor: bundleBusy.has(cli.id) ? "wait" : "pointer",
                      fontSize: "13px",
                      color: "var(--fg-primary)",
                    }}
                  >
                    {bundleBusy.has(cli.id) ? "Creating…" : "Create starter modes"}
                  </button>
                ) : variant === "oobe" ? (
                  // OOBE has nothing else here once a mode exists, so it keeps
                  // the confirmation label (round-3 m2 — dropping it removed
                  // OOBE's only "it worked" feedback).
                  <span
                    data-testid={`cli-all-created-${cli.id}`}
                    style={{ fontSize: "13px", color: "var(--fg-muted)" }}
                  >
                    ✓ all created
                  </span>
                ) : (
                  <div
                    data-testid={`default-channel-${cli.id}`}
                    style={{ display: "flex", flexDirection: "column", gap: 4 }}
                  >
                    <span style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-secondary)" }}>
                      Default channel
                    </span>
                    <Select
                      aria-label={`Default channel for ${cliDisplayName(cli.id)}`}
                      value={current}
                      onChange={(e) => onChannelChange(e.target.value as "json" | "tmux")}
                      disabled={pendingChannelChanges.has(cli.id)}
                      style={{ width: "auto", padding: "4px 8px", fontSize: 13 }}
                    >
                      <option value="json" disabled={!cli.supportsJson}>
                        Rich Chat{defaultOption === "json" ? " (built-in)" : ""}
                      </option>
                      <option value="tmux">
                        Terminal (tmux){defaultOption === "tmux" ? " (built-in)" : ""}
                      </option>
                    </Select>
                    {channelErrors[cli.id] ? (
                      <span style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-danger, #ef4444)" }}>
                        {channelErrors[cli.id]}
                      </span>
                    ) : null}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
