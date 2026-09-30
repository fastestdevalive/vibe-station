import { useEffect, useState, type ReactNode } from "react";
import { Github } from "lucide-react";
import type { ApiInstance } from "@/api";
import { Logo } from "@/components/shared/Logo";
import { SectionHeader } from "./SectionHeader";

function AgentName({ children }: { children: ReactNode }) {
  return (
    <strong
      style={{
        fontWeight: "var(--font-weight-semibold)",
        color: "var(--fg-primary)",
      }}
    >
      {children}
    </strong>
  );
}

/**
 * Last item in the settings nav. Version, a short mission statement, and
 * credits — the same purpose every IDE's "About" panel serves, styled to
 * match this app's settings conventions (inline styles + design tokens).
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
    <div style={{ maxWidth: 560, margin: "0 auto" }}>
      <SectionHeader title="About" description="Version, credits, and a bit of context." />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          gap: "var(--space-3)",
          padding: "var(--space-6) var(--space-4)",
          borderRadius: "var(--radius-md)",
          border: "var(--border-width) solid var(--border-default)",
          background: "var(--bg-card)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 56,
            height: 56,
            borderRadius: "var(--radius-md)",
            background: "var(--bg-active)",
            color: "var(--fg-primary)",
          }}
        >
          <Logo size={30} />
        </div>

        <div>
          <div
            style={{
              fontSize: "var(--font-size-lg)",
              fontWeight: "var(--font-weight-semibold)",
              color: "var(--fg-primary)",
            }}
          >
            Vibe Station
          </div>
          <div
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--fg-muted)",
              marginTop: "var(--space-1)",
            }}
          >
            {version ? `Version ${version}` : "Version —"}
          </div>
          <div
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--fg-muted)",
              marginTop: "var(--space-1)",
            }}
          >
            An <span style={{ textDecoration: "line-through" }}>IDE</span> ADE
          </div>
        </div>

        <div
          style={{
            fontSize: "var(--font-size-sm)",
            fontWeight: "var(--font-weight-medium)",
            color: "var(--fg-primary)",
          }}
        >
          Vibe code in parallel. Ship at scale.
        </div>

        <p
          style={{
            maxWidth: 460,
            fontSize: "var(--font-size-sm)",
            lineHeight: 1.6,
            color: "var(--fg-secondary)",
            margin: 0,
          }}
        >
          Vibe Station was built because managing multiple projects — with multiple agents
          working across a pile of terminal tabs — was getting hard to keep straight. And
          orchestrating them was harder still:{" "}
          <span style={{ color: "var(--fg-primary)" }}>
            plan with <AgentName>Claude Opus</AgentName>, get it reviewed by{" "}
            <AgentName>Gemini</AgentName>, implement with <AgentName>DeepSeek</AgentName>.
          </span>{" "}
          Now you can run all of that side by side, in one place, without losing track of any of
          it.
        </p>

        <a
          href="https://github.com/fastestdevalive/vibe-station"
          target="_blank"
          rel="noreferrer"
          className="icon-btn"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--space-2)",
            width: "auto",
            height: "auto",
            padding: "var(--space-2) var(--space-3)",
            marginTop: "var(--space-1)",
          }}
        >
          <Github size={14} />
          <span style={{ fontSize: "var(--font-size-xs)" }}>Source on GitHub</span>
        </a>
      </div>

      <div
        style={{
          marginTop: "var(--space-4)",
          textAlign: "center",
          fontSize: "var(--font-size-xs)",
          color: "var(--fg-muted)",
          lineHeight: 1.6,
        }}
      >
        Made with care & crafted with ❤️ from India.
      </div>
    </div>
  );
}
