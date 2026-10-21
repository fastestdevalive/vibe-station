import { useState } from "react";
import type { ApiInstance } from "@/api";
import type { SupportedCli } from "@/api/types";
import { DoctorHintBlock } from "@/components/doctor/DoctorHintBlock";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { cliDisplayName } from "@/lib/cliNames";
import { SettingsRow } from "./SettingsRow";
import { harnessPanelId, harnessTabId } from "./HarnessTabs";
import "./harness.css";

interface HarnessPanelProps {
  api: ApiInstance;
  cli: SupportedCli;
  /** Whether any mode already uses this harness (drives "Create starter modes"). */
  hasAnyMode: boolean;
  /** Re-fetch harness detection after a change. */
  onChanged: () => Promise<void> | void;
}

/**
 * Detection state, default channel and install hint for one harness. Behaviour
 * mirrors the former per-harness card (CliDetectionPanel variant="settings"):
 * same default-channel PATCH semantics, `supportsJson` gating and starter-bundle
 * action.
 */
export function HarnessPanel({ api, cli, hasAnyMode, onChanged }: HarnessPanelProps) {
  const [channelError, setChannelError] = useState("");
  const [channelPending, setChannelPending] = useState(false);
  const [bundleError, setBundleError] = useState("");
  const [bundleBusy, setBundleBusy] = useState(false);

  // The effective `defaultChannel` is one of the two options; whichever one is
  // the plugin's OWN default (the other option when `defaultChannelOverridden`
  // is true) carries "(built-in)" and, when selected, CLEARS the override.
  const current: "json" | "tmux" = cli.defaultChannel === "tmux" ? "tmux" : "json";
  const other: "json" | "tmux" = current === "json" ? "tmux" : "json";
  const defaultOption: "json" | "tmux" = cli.defaultChannelOverridden ? other : current;

  function onChannelChange(value: "json" | "tmux") {
    const payload = value === defaultOption ? null : value;
    setChannelError("");
    setChannelPending(true);
    void api
      .updateSettings({ defaultChannelByCli: { [cli.id]: payload } })
      .then(() => onChanged())
      .catch((err: unknown) => {
        setChannelError(err instanceof Error ? err.message : "Couldn't update the default channel.");
      })
      .finally(() => setChannelPending(false));
  }

  async function createBundle() {
    setBundleBusy(true);
    try {
      const res = await api.createStarterBundle(cli.id);
      setBundleError(res.modelsError ?? "");
    } catch (e) {
      setBundleError(e instanceof Error ? e.message : "Couldn't create the starter modes.");
    }
    try {
      await onChanged();
    } finally {
      setBundleBusy(false);
    }
  }

  const name = cliDisplayName(cli.id);
  return (
    <div
      role="tabpanel"
      id={harnessPanelId(cli.id)}
      aria-labelledby={harnessTabId(cli.id)}
      className="harness-panel"
      data-testid={`cli-row-${cli.id}`}
    >
      <SettingsRow
        label={
          <span data-testid={`cli-name-${cli.id}`}>{name}</span>
        }
        description={
          <span
            data-testid={`cli-detected-${cli.id}`}
            className={cli.detected ? "harness-state harness-state--ok" : "harness-state"}
          >
            {cli.detected ? "✓ detected" : "✘ not found"}
          </span>
        }
        control={
          cli.detected && !hasAnyMode ? (
            <Button type="button" onClick={() => void createBundle()} disabled={bundleBusy}>
              {bundleBusy ? "Creating…" : "Create starter modes"}
            </Button>
          ) : undefined
        }
      />
      {bundleError ? (
        <div className="settings-error" data-testid={`bundle-error-${cli.id}`}>
          {bundleError}
        </div>
      ) : null}
      {cli.usingFallbackOnly && (
        <p className="settings-help">
          Using a generic fallback mode — model discovery didn&apos;t succeed for the named bundle.
        </p>
      )}
      {cli.detected ? (
        <SettingsRow
          label="Default channel"
          description="Used when a new session of this harness doesn't pick one."
          control={
            <div data-testid={`default-channel-${cli.id}`}>
              <Select
                aria-label={`Default channel for ${name}`}
                value={current}
                onChange={(e) => onChannelChange(e.target.value as "json" | "tmux")}
                disabled={channelPending}
                style={{ width: "auto", padding: "4px 8px", fontSize: 13 }}
              >
                <option value="json" disabled={!cli.supportsJson}>
                  Rich Chat{defaultOption === "json" ? " (built-in)" : ""}
                </option>
                <option value="tmux">Terminal (tmux){defaultOption === "tmux" ? " (built-in)" : ""}</option>
              </Select>
            </div>
          }
        />
      ) : cli.installHint ? (
        <DoctorHintBlock hint={cli.installHint} hostOs="any" />
      ) : (
        <p className="settings-help">Install with your package manager, then re-check.</p>
      )}
      {channelError ? <div className="settings-error">{channelError}</div> : null}
    </div>
  );
}
