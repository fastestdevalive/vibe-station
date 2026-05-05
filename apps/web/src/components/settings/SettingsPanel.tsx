import { useCallback, useRef } from "react";
import type { ApiInstance } from "@/api";
import { ModesSetting } from "./ModesSetting";

interface SettingsPanelProps {
  api: ApiInstance;
}

export function SettingsPanel({ api }: SettingsPanelProps) {
  const modesRef = useRef<HTMLElement | null>(null);

  const scrollToModes = useCallback(() => {
    modesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div
      className="settings-panel"
      style={{
        height: "100%",
        display: "grid",
        gridTemplateColumns: "200px 1fr",
        gap: "var(--space-5)",
        padding: "var(--space-5)",
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <nav
        className="settings-nav"
        aria-label="Settings sections"
        style={{
          borderRight: "var(--border-width) solid var(--border-default)",
          paddingRight: "var(--space-4)",
        }}
      >
        <div
          style={{
            fontSize: "12px",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: "var(--fg-muted)",
            marginBottom: "var(--space-3)",
          }}
        >
          Settings
        </div>
        <button
          type="button"
          onClick={scrollToModes}
          className="settings-nav__link"
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            padding: "var(--space-2) var(--space-3)",
            borderRadius: "var(--radius-sm)",
            border: "none",
            background: "transparent",
            color: "var(--fg-primary)",
            cursor: "pointer",
            font: "inherit",
          }}
        >
          Modes
        </button>
      </nav>
      <div
        className="settings-content"
        style={{
          overflow: "auto",
          minHeight: 0,
        }}
      >
        <section
          id="settings-modes"
          ref={modesRef}
          style={{ scrollMarginTop: "var(--space-3)" }}
        >
          <ModesSetting api={api} />
        </section>
      </div>
    </div>
  );
}
