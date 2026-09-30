import { useState, useEffect } from "react";
import type { ApiInstance } from "@/api";
import { useDoctorStatus } from "@/hooks/useDoctorStatus";
import { DoctorCheckList } from "@/components/doctor/DoctorCheckList";
import { SectionHeader } from "./SectionHeader";

interface DoctorSettingProps {
  api: ApiInstance;
}

export function DoctorSetting({ api }: DoctorSettingProps) {
  const { fetchState, report, lastCheckedAt, checking, recheck } = useDoctorStatus(api);
  const [secondsAgo, setSecondsAgo] = useState<number | null>(null);

  useEffect(() => {
    if (lastCheckedAt === null) return;
    const update = () => setSecondsAgo(Math.floor((Date.now() - lastCheckedAt) / 1000));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [lastCheckedAt]);

  // Gate the summary on report.ok (server-computed) so it stays in sync with
  // the sidebar badge and OOBE Continue button — both use the same field.
  // The count mirrors the daemon's compute_hard_ok/compute_ok: a required check fails
  // unless ok/timeout, and the agent-CLI rule is one issue when no CLI is ok
  // (missing CLIs are "warn", never "error", so they must not be counted raw).
  const issueCount = report
    ? report.checks.filter(
        (c) => c.group === "required" && c.status !== "ok" && c.status !== "timeout",
      ).length +
      (report.checks.some((c) => c.group === "agent_cli" && c.status === "ok") ? 0 : 1) +
      report.checks.filter((c) => c.group === "feature" && c.status === "error").length
    : 0;

  return (
    <div>
      <SectionHeader title="Doctor" />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", gap: "var(--space-3)", marginBottom: "var(--space-1)" }}>
        {report ? (
          <span
            style={{
              fontSize: "var(--font-size-sm)",
              fontWeight: 500,
              color: report.ok ? "var(--fg-success)" : "var(--fg-danger)",
            }}
          >
            {report.ok
              ? "✓ All checks passing"
              : `✗ ${issueCount > 0 ? `${issueCount} check${issueCount !== 1 ? "s" : ""} need attention` : "Some checks need attention"}`}
          </span>
        ) : (
          <span style={{ fontSize: "var(--font-size-sm)", color: "var(--fg-secondary)" }}>
            {fetchState === "unreachable" ? "Can't reach daemon" : "Checking…"}
          </span>
        )}
        <button
          type="button"
          className="btn btn--ghost"
          disabled={checking}
          onClick={recheck}
          style={{ fontSize: "var(--font-size-xs)" }}
        >
          {checking ? "Checking…" : "Re-check"}
        </button>
      </div>
      {report && (
        <div style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-muted)", marginBottom: "var(--space-3)" }}>
          Checked on {report.hostname} ({report.hostOs})
          {lastCheckedAt !== null && secondsAgo !== null && ` · Last checked ${secondsAgo}s ago`}
        </div>
      )}

      {fetchState === "unreachable" ? (
        <p style={{ color: "var(--fg-danger)", fontSize: "var(--font-size-sm)" }}>
          Can't reach daemon — please check that vibe-station is running and reload.
        </p>
      ) : report ? (
        <>
          <DoctorCheckList
            checks={report.checks}
            hostname={report.hostname}
            hostOs={report.hostOs}
            groupBy
          />
        </>
      ) : (
        <p style={{ color: "var(--fg-secondary)", fontSize: "var(--font-size-sm)" }}>Running checks…</p>
      )}
    </div>
  );
}
