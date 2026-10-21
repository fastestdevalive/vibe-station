import { useEffect, useState, type ReactNode } from "react";
import { Github } from "lucide-react";
import type { ApiInstance } from "@/api";
import { Logo } from "@/components/shared/Logo";
import { SectionHeader } from "./SectionHeader";
import { SettingsRow } from "./SettingsRow";
import { THIRD_PARTY_LICENSES } from "./thirdPartyLicenses";
import "./settings.css";

function AgentName({ children }: { children: ReactNode }) {
  return <strong style={{ fontWeight: "var(--font-weight-semibold)", color: "var(--fg-primary)" }}>{children}</strong>;
}

/**
 * Last item in the settings nav: version, a short mission statement, source
 * link and third-party credits, built from the shared settings row anatomy.
 */
export function AboutSetting({ api }: { api: ApiInstance }) {
  // Not `web-ui/package.json`'s version — that file is a placeholder
  // ("0.0.0") frozen at scaffold time, not bumped with real releases. The
  // daemon's own `/health` response is the actual source of truth for the
  // running version (confirmed via `vst daemon status`).
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void api.health().then((res) => setVersion(res.version));
  }, [api]);

  return (
    <div>
      <SectionHeader title="About" description="Version, credits, and a bit of context." />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          paddingBottom: "var(--space-3)",
          borderBottom: "var(--border-width) solid var(--border-subtle, var(--border-default))",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 44,
            height: 44,
            flexShrink: 0,
            borderRadius: "var(--radius-md)",
            background: "var(--bg-active)",
            color: "var(--fg-primary)",
          }}
        >
          <Logo size={24} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: "var(--font-size-base)",
              fontWeight: "var(--font-weight-semibold)",
              color: "var(--fg-primary)",
            }}
          >
            Vibe Station
          </div>
          <div style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-muted)" }}>
            An <span style={{ textDecoration: "line-through" }}>IDE</span> ADE · Vibe code in parallel. Ship at scale.
          </div>
        </div>
      </div>

      <SettingsRow
        label="Version"
        description="The running daemon's version."
        control={
          <span className="settings-mono selectable" style={{ fontSize: "var(--font-size-sm)", color: "var(--fg-secondary)" }}>
            {version ?? "—"}
          </span>
        }
      />
      <SettingsRow
        label="Source code"
        description="Open source on GitHub."
        control={
          <a
            href="https://github.com/fastestdevalive/vibe-station"
            target="_blank"
            rel="noreferrer"
            className="btn btn--secondary settings-btn"
          >
            <Github size={14} aria-hidden />
            <span>Source on GitHub</span>
          </a>
        }
      />

      <p className="settings-help">
        Vibe Station was built because managing multiple projects — with multiple agents working
        across a pile of terminal tabs — was getting hard to keep straight. And orchestrating them
        was harder still:{" "}
        <span style={{ color: "var(--fg-primary)" }}>
          plan with <AgentName>Claude Opus</AgentName>, get it reviewed by <AgentName>Gemini</AgentName>,
          implement with <AgentName>DeepSeek</AgentName>.
        </span>{" "}
        Now you can run all of that side by side, in one place, without losing track of any of it.
      </p>
      <p className="settings-help" style={{ color: "var(--fg-muted)", fontSize: "var(--font-size-xs)" }}>
        Made with care & crafted with ❤️ from India.
      </p>

      <div style={{ marginTop: "var(--space-6)" }}>
        <SectionHeader
          title="Third-party licenses"
          description="Components redistributed with Vibe Station, with links to their upstream licenses."
        />
        {THIRD_PARTY_LICENSES.map((item) => (
          <SettingsRow
            key={item.name}
            label={item.name}
            description={
              <>
                {item.role} ·{" "}
                <a href={item.url} target="_blank" rel="noreferrer" className="settings-link">
                  {item.license}
                </a>
              </>
            }
          />
        ))}
      </div>
    </div>
  );
}
