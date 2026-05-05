import { useCallback, useId, useRef, useState } from "react";
import { motion } from "framer-motion";
import type { ApiInstance } from "@/api";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { ModesSetting } from "./ModesSetting";

interface Section {
  id: string;
  label: string;
  content: React.ReactNode;
}

interface SettingsPanelProps {
  api: ApiInstance;
}

export function SettingsPanel({ api }: SettingsPanelProps) {
  const isMobile = useMediaQuery("(max-width: 768px)");
  const modesRef = useRef<HTMLElement | null>(null);
  const [activeTab, setActiveTab] = useState("modes");
  const tabLayoutId = useId();

  const sections: Section[] = [
    {
      id: "modes",
      label: "Modes",
      content: <ModesSetting api={api} />,
    },
  ];

  const scrollToModes = useCallback(() => {
    modesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // ── Mobile: pill tabs ────────────────────────────────────────────────────
  if (isMobile) {
    const activeSection = sections.find((s) => s.id === activeTab) ?? sections[0]!;
    return (
      <div
        className="settings-panel"
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          boxSizing: "border-box",
          overflow: "hidden",
        }}
      >
        {/* Pill tab bar */}
        <div
          style={{
            flexShrink: 0,
            padding: "var(--space-3) var(--space-3) 0",
          }}
        >
          {/* inline-flex so the pill shrinks to its content, not full row width */}
          <div
            role="tablist"
            style={{
              display: "inline-flex",
              gap: "var(--space-2)",
              background: "var(--bg-card)",
              border: "var(--border-width) solid var(--border-default)",
              borderRadius: "var(--radius-lg)",
              padding: "var(--space-2)",
            }}
          >
            {sections.map((section) => (
              <button
                key={section.id}
                role="tab"
                aria-selected={activeTab === section.id}
                type="button"
                onClick={() => setActiveTab(section.id)}
                style={{
                  position: "relative",
                  flex: "none",
                  border: "none",
                  background: "transparent",
                  borderRadius: "var(--radius-md)",
                  padding: "var(--space-3) var(--space-5)",
                  cursor: "pointer",
                  font: "inherit",
                  fontSize: "var(--font-size-sm)",
                  fontWeight: "var(--font-weight-medium)",
                  color: activeTab === section.id ? "var(--fg-primary)" : "var(--fg-muted)",
                  transition: "color 150ms ease",
                  minHeight: 40,
                  whiteSpace: "nowrap",
                }}
              >
                {activeTab === section.id && (
                  <motion.span
                    layoutId={`tab-indicator-${tabLayoutId}`}
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: "var(--bg-active)",
                      borderRadius: "var(--radius-md)",
                      zIndex: 0,
                    }}
                    transition={{ type: "spring", stiffness: 400, damping: 30, mass: 0.8 }}
                  />
                )}
                <span style={{ position: "relative", zIndex: 1 }}>{section.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Active section content */}
        <div
          role="tabpanel"
          style={{
            flex: 1,
            overflow: "auto",
            padding: "var(--space-3)",
            minHeight: 0,
          }}
        >
          {activeSection.content}
        </div>
      </div>
    );
  }

  // ── Desktop: side nav + scrollable content ───────────────────────────────
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
