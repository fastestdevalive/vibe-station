import { useState } from "react";
import type { DoctorCheckDto, DoctorCheckStatus } from "@/api/types";
import { copyText } from "@/lib/copyText";

interface DoctorCheckListProps {
  checks: DoctorCheckDto[];
  hostname: string;
  hostOs: string;
  groupBy?: boolean;
}

const STATUS_GLYPH: Record<DoctorCheckStatus, string> = {
  ok: "✓",
  warn: "⚠",
  error: "✗",
  timeout: "—",
};

const STATUS_LABEL: Record<DoctorCheckStatus, string> = {
  ok: "OK",
  warn: "Warning",
  error: "Missing",
  timeout: "Timeout",
};

const STATUS_COLOR: Record<DoctorCheckStatus, string> = {
  ok: "var(--fg-success, var(--fg-primary))",
  warn: "var(--fg-warning, var(--fg-primary))",
  error: "var(--fg-danger, var(--fg-primary))",
  timeout: "var(--fg-muted, var(--fg-secondary))",
};

interface CheckRowProps {
  check: DoctorCheckDto;
  hostname: string;
  hostOs: string;
}

function CheckRow({ check, hostname, hostOs }: CheckRowProps) {
  const [copied, setCopied] = useState(false);
  const glyph = STATUS_GLYPH[check.status];
  const label = STATUS_LABEL[check.status];
  const color = STATUS_COLOR[check.status];

  const handleCopy = () => {
    if (!check.installHint) return;
    copyText(check.installHint);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      style={{
        padding: "var(--space-2) 0",
        borderBottom: "var(--border-width) solid var(--border-subtle, var(--border-default))",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <span style={{ color, fontWeight: "bold", minWidth: "1.2em", textAlign: "center" }} aria-hidden="true">
          {glyph}
        </span>
        <span style={{ color, fontSize: "var(--font-size-xs)", minWidth: "4em" }}>{label}</span>
        <span style={{ fontWeight: "500", flexGrow: 1 }}>{check.name}</span>
        <span style={{ color: "var(--fg-secondary)", fontSize: "var(--font-size-sm)" }}>{check.message}</span>
      </div>
      {check.resolvedPath && (
        <div style={{ marginTop: "var(--space-1)", marginLeft: "calc(1.2em + var(--space-2) + 4em + var(--space-2))" }}>
          <code style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-secondary)" }}>
            Resolved: {check.resolvedPath}
          </code>
        </div>
      )}
      {check.status !== "ok" && check.installHint && (
        <div style={{ marginTop: "var(--space-1)", marginLeft: "calc(1.2em + var(--space-2) + 4em + var(--space-2))" }}>
          <div style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-secondary)", marginBottom: "var(--space-1)" }}>
            Run on {hostname} ({hostOs}):
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <code
              style={{
                fontSize: "var(--font-size-xs)",
                color: "var(--fg-primary)",
                background: "var(--bg-input)",
                border: "var(--border-width) solid var(--border-default)",
                borderRadius: "var(--radius-sm)",
                padding: "2px var(--space-2)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: "100%",
              }}
            >
              {check.installHint}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              style={{
                flexShrink: 0,
                fontSize: "var(--font-size-xs)",
                fontFamily: "inherit",
                lineHeight: 1,
                padding: "4px var(--space-3)",
                border: "var(--border-width) solid var(--border-default)",
                borderRadius: "var(--radius-md)",
                background: "var(--bg-surface, var(--bg-card))",
                color: "var(--fg-primary)",
                cursor: "pointer",
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
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
      {detail && (
        <span style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-secondary)" }}>{detail}</span>
      )}
    </div>
  );
}

export function DoctorCheckList({ checks, hostname, hostOs, groupBy }: DoctorCheckListProps) {
  if (!groupBy) {
    return (
      <div>
        {checks.map((c) => (
          <CheckRow key={c.name} check={c} hostname={hostname} hostOs={hostOs} />
        ))}
      </div>
    );
  }

  const required = checks.filter((c) => c.group === "required");
  const agentCli = checks.filter((c) => c.group === "agent_cli");
  const feature = checks.filter((c) => c.group === "feature");
  const rest = checks.filter((c) => c.group === "optional" || c.group === "diagnostic");

  const reqPass = required.filter((c) => c.status === "ok" || c.status === "timeout").length;
  const agentPass = agentCli.filter((c) => c.status === "ok").length;
  const featurePass = feature.filter((c) => c.status === "ok").length;

  return (
    <div>
      {required.length > 0 && (
        <>
          <SectionHeading
            title="Required"
            detail={`${reqPass} of ${required.length} required checks OK`}
          />
          {required.map((c) => (
            <CheckRow key={c.name} check={c} hostname={hostname} hostOs={hostOs} />
          ))}
        </>
      )}
      {agentCli.length > 0 && (
        <>
          <SectionHeading
            title="Agent CLIs"
            detail={`${agentPass} of ${agentCli.length} found (need ≥1)`}
          />
          {agentCli.map((c) => (
            <CheckRow key={c.name} check={c} hostname={hostname} hostOs={hostOs} />
          ))}
        </>
      )}
      {feature.length > 0 && (
        <>
          <SectionHeading title="Features" />
          {feature.map((c) => (
            <CheckRow key={c.name} check={c} hostname={hostname} hostOs={hostOs} />
          ))}
        </>
      )}
      {rest.length > 0 && (
        <>
          <SectionHeading title="Optional" />
          {rest.map((c) => (
            <CheckRow key={c.name} check={c} hostname={hostname} hostOs={hostOs} />
          ))}
        </>
      )}
    </div>
  );
}
