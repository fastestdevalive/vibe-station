import { useState, useEffect } from "react";
import type { ApiInstance } from "@/api";
import { useDoctorStatus } from "@/hooks/useDoctorStatus";
import { DoctorCheckList } from "@/components/doctor/DoctorCheckList";
import { doctorSummary } from "@/components/doctor/doctorSummary";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
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

  // The summary comes from doctorSummary (same wording as onboarding step 3) so it
  // always agrees with the list below; report.ok still drives the sidebar badge.
  // "Needs attention" = every non-OK check (warnings included), shown first.
  const attentionCount = report ? report.checks.filter((c) => c.status !== "ok").length : 0;
  const [pickedFilter, setPickedFilter] = useState<"all" | "attention" | null>(null);
  const filter = pickedFilter ?? (attentionCount > 0 ? "attention" : "all");

  const summary = report ? doctorSummary(report.checks) : null;

  return (
    <div>
      <SectionHeader title="Doctor" />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", gap: "var(--space-3)", marginBottom: "var(--space-1)" }}>
        {summary ? (
          <span
            data-testid="doctor-summary"
            style={{
              fontSize: "var(--font-size-sm)",
              fontWeight: 500,
              color:
                summary.tone === "ok"
                  ? "var(--fg-success)"
                  : summary.tone === "fail"
                    ? "var(--fg-danger)"
                    : "var(--fg-primary)",
            }}
          >
            {summary.tone === "ok" ? "✓ " : summary.tone === "fail" ? "✗ " : ""}
            {summary.text}
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
          {summary && summary.counts.missing + summary.counts.warnings > 0 &&
            ` · ${summary.counts.missing} missing · ${summary.counts.warnings} warning${summary.counts.warnings === 1 ? "" : "s"}`}
        </div>
      )}

      {report && (
        <div style={{ marginBottom: "var(--space-2)" }}>
          <SegmentedControl
            options={[
              { value: "all", label: `All ${report.checks.length}` },
              { value: "attention", label: `Needs attention ${attentionCount}` },
            ]}
            value={filter}
            onChange={(v) => setPickedFilter(v === "attention" ? "attention" : "all")}
          />
        </div>
      )}

      {fetchState === "unreachable" ? (
        <p style={{ color: "var(--fg-danger)", fontSize: "var(--font-size-sm)" }}>
          Can't reach daemon — please check that vibe-station is running and reload.
        </p>
      ) : report ? (
        <>
          <DoctorCheckList
            api={api}
            checks={report.checks}
            hostname={report.hostname}
            hostOs={report.hostOs}
            groupBy
            filter={filter}
            onChanged={recheck}
          />
        </>
      ) : (
        <p style={{ color: "var(--fg-secondary)", fontSize: "var(--font-size-sm)" }}>Running checks…</p>
      )}
    </div>
  );
}
