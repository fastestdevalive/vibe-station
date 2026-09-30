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

const STATUS_BADGE_STYLE: Record<
  DoctorCheckStatus,
  { color: string; bg: string; border: string }
> = {
  ok: {
    color: "var(--fg-success, var(--fg-primary))",
    bg: "color-mix(in srgb, var(--fg-success) 12%, transparent)",
    border: "color-mix(in srgb, var(--fg-success) 28%, transparent)",
  },
  warn: {
    color: "var(--fg-warning, var(--fg-primary))",
    bg: "color-mix(in srgb, var(--fg-warning) 12%, transparent)",
    border: "color-mix(in srgb, var(--fg-warning) 28%, transparent)",
  },
  error: {
    color: "var(--fg-danger, var(--fg-primary))",
    bg: "color-mix(in srgb, var(--fg-danger) 12%, transparent)",
    border: "color-mix(in srgb, var(--fg-danger) 28%, transparent)",
  },
  timeout: {
    color: "var(--fg-muted, var(--fg-secondary))",
    bg: "color-mix(in srgb, var(--fg-muted, var(--fg-secondary)) 12%, transparent)",
    border: "color-mix(in srgb, var(--fg-muted, var(--fg-secondary)) 28%, transparent)",
  },
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
  const badgeStyle = STATUS_BADGE_STYLE[check.status];

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
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: "var(--space-4)",
      }}
    >
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "flex-start", minWidth: "5.5em" }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--space-1)",
            fontSize: "var(--font-size-xs)",
            fontWeight: "500",
            lineHeight: 1.2,
            padding: "2px var(--space-2)",
            borderRadius: "var(--radius-sm)",
            color: badgeStyle.color,
            background: badgeStyle.bg,
            border: `var(--border-width) solid ${badgeStyle.border}`,
          }}
        >
          <span style={{ fontWeight: "bold" }} aria-hidden="true">
            {glyph}
          </span>
          <span>{label}</span>
        </span>
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <span style={{ fontWeight: "500", color: "var(--fg-primary)" }}>{check.name}</span>
          {check.message && (
            <span style={{ color: "var(--fg-secondary)", fontSize: "var(--font-size-sm)" }}>{check.message}</span>
          )}
        </div>
        {check.resolvedPath && (
          <div style={{ marginTop: "var(--space-1)" }}>
            <code style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-secondary)" }}>
              Resolved: {check.resolvedPath}
            </code>
          </div>
        )}
        {check.status !== "ok" && check.installHint && (
          <div style={{ marginTop: "var(--space-1)" }}>
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
