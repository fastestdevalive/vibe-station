import { useState, useEffect } from "react";
import type { ApiInstance } from "@/api";
import { useDoctorStatus } from "@/hooks/useDoctorStatus";
import { DoctorCheckList } from "@/components/doctor/DoctorCheckList";

interface OobeStep3DoctorProps {
  api: ApiInstance;
  onCompleted: () => void;
}

export function OobeStep3Doctor({ api, onCompleted }: OobeStep3DoctorProps) {
  const { fetchState, report, lastCheckedAt, checking, recheck } = useDoctorStatus(api);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [completeBusy, setCompleteBusy] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [secondsAgo, setSecondsAgo] = useState<number | null>(null);

  useEffect(() => {
    if (lastCheckedAt === null) return;
    const update = () => setSecondsAgo(Math.floor((Date.now() - lastCheckedAt) / 1000));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [lastCheckedAt]);

  async function doComplete() {
    setCompleteError(null);
    setCompleteBusy(true);
    try {
      await api.completeOobe();
      onCompleted();
    } catch (e) {
      setCompleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setCompleteBusy(false);
    }
  }

  if (fetchState === "unreachable") {
    return (
      <div style={{ padding: "var(--space-4)" }}>
        <p style={{ color: "var(--fg-danger)" }}>Can't reach daemon — please check that vibe-station is running and reload.</p>
        <button type="button" className="btn btn--ghost" disabled={checking} onClick={recheck}>
          {checking ? "Checking…" : "Re-check"}
        </button>
      </div>
    );
  }

  const canContinue = !!report?.ok;
  const showContinueAnyway = !!report && report.hardOk && !report.ok;

  return (
    <div style={{ padding: "var(--space-2) 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-3)" }}>
        <span style={{ fontSize: "var(--font-size-sm)", color: "var(--fg-secondary)" }}>
          {report
            ? `Checked on: ${report.hostname} (${report.hostOs})`
            : "Checking…"}
        </span>
        {lastCheckedAt !== null && secondsAgo !== null && (
          <span style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-muted)" }}>
            · Last checked {secondsAgo}s ago
          </span>
        )}
        <button
          type="button"
          className="btn btn--ghost"
          disabled={checking}
          onClick={recheck}
          style={{ marginLeft: "auto", fontSize: "var(--font-size-xs)" }}
        >
          {checking ? "Checking…" : "Re-check"}
        </button>
      </div>

      {report ? (
        <DoctorCheckList
          checks={report.checks}
          hostname={report.hostname}
          hostOs={report.hostOs}
        />
      ) : (
        <p style={{ color: "var(--fg-secondary)", fontSize: "var(--font-size-sm)" }}>Running checks…</p>
      )}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: "var(--space-2)",
          marginTop: "var(--space-4)",
        }}
      >
        {completeError && (
          <div className="field-error" data-testid="oobe-step3-error">
            {completeError}
          </div>
        )}
        {showContinueAnyway && !showConfirm && (
          <button
            type="button"
            className="btn btn--ghost"
            style={{ fontSize: "var(--font-size-sm)" }}
            onClick={() => setShowConfirm(true)}
          >
            Continue anyway
          </button>
        )}
        {showContinueAnyway && showConfirm && (
          <div
            style={{
              fontSize: "var(--font-size-sm)",
              color: "var(--fg-warning)",
              textAlign: "right",
              maxWidth: "32em",
            }}
          >
            You have no agent CLI installed — most of vibe-station won't work until you install one. Continue anyway?{" "}
            <button
              type="button"
              className="btn btn--ghost"
              style={{ fontSize: "var(--font-size-sm)", display: "inline" }}
              onClick={() => void doComplete()}
            >
              Yes, continue
            </button>
            {" "}
            <button
              type="button"
              className="btn btn--ghost"
              style={{ fontSize: "var(--font-size-sm)", display: "inline" }}
              onClick={() => setShowConfirm(false)}
            >
              Cancel
            </button>
          </div>
        )}
        <button
          type="button"
          data-testid="oobe-step3-continue"
          className="btn btn--primary"
          disabled={!canContinue || completeBusy}
          onClick={() => void doComplete()}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
