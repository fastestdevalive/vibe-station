import { useState } from "react";
import type { ApiInstance } from "@/api";
import type { DoctorCheckDto } from "@/api/types";
import { DoctorRow } from "./DoctorRow";
import "./doctor.css";

interface DoctorCheckListProps {
  api: ApiInstance;
  checks: DoctorCheckDto[];
  hostname: string;
  hostOs: string;
  groupBy?: boolean;
  /** Re-run the doctor after an in-app action (Forget / Kill). */
  onChanged?: () => void;
  /** Flat list only: failing checks first, passing ones folded into one row. */
  foldPassing?: boolean;
  /** "attention" hides OK rows. */
  filter?: "all" | "attention";
  /** Collapse per-item lists (orphans) to this many rows. */
  itemsCollapsedCount?: number;
}

function SectionHeading({ title, detail }: { title: string; detail?: string }) {
  return (
    <div
      style={{
        marginTop: "var(--space-4)",
        marginBottom: "var(--space-2)",
        display: "flex",
        alignItems: "baseline",
        gap: "var(--space-2)",
      }}
    >
      <span style={{ fontWeight: "600", fontSize: "var(--font-size-sm)" }}>{title}</span>
      {detail && <span style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-secondary)" }}>{detail}</span>}
    </div>
  );
}

export function DoctorCheckList({
  api,
  checks,
  hostname,
  hostOs,
  groupBy,
  onChanged,
  foldPassing,
  filter = "all",
  itemsCollapsedCount,
}: DoctorCheckListProps) {
  const [passingOpen, setPassingOpen] = useState(false);
  const refresh = onChanged ?? (() => {});

  const row = (c: DoctorCheckDto) => (
    <DoctorRow
      key={c.name}
      api={api}
      check={c}
      hostOs={hostOs}
      hostname={hostname}
      onChanged={refresh}
      itemsCollapsedCount={itemsCollapsedCount}
    />
  );
  const visible = (list: DoctorCheckDto[]) =>
    filter === "attention" ? list.filter((c) => c.status !== "ok") : list;

  if (!groupBy) {
    const list = visible(checks);
    if (!foldPassing) return <div>{list.map(row)}</div>;

    // Severity first (Missing → Warning → Timeout); stable sort keeps daemon order within a severity.
    const rank: Record<string, number> = { error: 0, warn: 1, timeout: 2 };
    const failing = list
      .filter((c) => c.status !== "ok")
      .sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3));
    const passing = list.filter((c) => c.status === "ok");
    return (
      <div>
        {failing.map(row)}
        {passing.length > 0 ? (
          <>
            <div className="doctor-fold">
              <span>
                {passing.length} check{passing.length === 1 ? "" : "s"} passed ·{" "}
                {passing.map((c) => c.name).join(", ")}
              </span>
              <button
                type="button"
                className="doctor-fold__toggle"
                aria-expanded={passingOpen}
                onClick={() => setPassingOpen((o) => !o)}
              >
                {passingOpen ? "Hide" : "Show"}
              </button>
            </div>
            {passingOpen ? passing.map(row) : null}
          </>
        ) : null}
      </div>
    );
  }

  const required = checks.filter((c) => c.group === "required");
  const agentCli = checks.filter((c) => c.group === "agent_cli");
  const feature = checks.filter((c) => c.group === "feature");
  const rest = checks.filter((c) => c.group === "optional" || c.group === "diagnostic");

  const reqPass = required.filter((c) => c.status === "ok" || c.status === "timeout").length;
  const agentPass = agentCli.filter((c) => c.status === "ok").length;

  return (
    <div>
      {visible(required).length > 0 && (
        <>
          <SectionHeading title="Required" detail={`${reqPass} of ${required.length} required checks OK`} />
          {visible(required).map(row)}
        </>
      )}
      {visible(agentCli).length > 0 && (
        <>
          <SectionHeading title="Agent CLIs" detail={`${agentPass} of ${agentCli.length} found (need ≥1)`} />
          {visible(agentCli).map(row)}
        </>
      )}
      {visible(feature).length > 0 && (
        <>
          <SectionHeading title="Features" />
          {visible(feature).map(row)}
        </>
      )}
      {visible(rest).length > 0 && (
        <>
          <SectionHeading title="Optional" />
          {visible(rest).map(row)}
        </>
      )}
    </div>
  );
}
