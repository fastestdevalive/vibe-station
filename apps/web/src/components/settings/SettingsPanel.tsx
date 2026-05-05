import { useCallback, useId, useRef, useState } from "react";
import { motion } from "framer-motion";
import type { ApiInstance } from "@/api";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { ModesSetting } from "./ModesSetting";
import { AppearanceSetting } from "./AppearanceSetting";

interface Section {
  id: string;
  label: string;
  ref: React.RefObject<HTMLElement | null>;
  content: React.ReactNode;
}

interface SettingsPanelProps {
  api: ApiInstance;
}

export function SettingsPanel({ api }: SettingsPanelProps) {
  const isMobile = useMediaQuery("(max-width: 768px)");
  const modesRef = useRef<HTMLElement | null>(null);
  const appearanceRef = useRef<HTMLElement | null>(null);
  const [activeTab, setActiveTab] = useState("modes");
  const tabLayoutId = useId();

  const sections: Section[] = [
    {
      id: "modes",
      label: "Modes",
      ref: modesRef,
      content: <ModesSetting api={api} />,
    },
    {
      id: "appearance",
      label: "Appearance",
      ref: appearanceRef,
      content: <AppearanceSetting />,
    },
  ];

  const scrollTo = useCallback((ref: React.RefObject<HTMLElement | null>) => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // ── Mobile: underline tabs ───────────────────────────────────────────────
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
        {/* Underline tab bar — matches design system `variant="underline"` */}
        <div
          role="tablist"
          style={{
            flexShrink: 0,
            display: "flex",
            gap: "var(--space-1)",
            borderBottom: "var(--border-width) solid var(--border-default)",
            padding: "0 var(--space-3)",
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
                padding: "var(--space-3) var(--space-3)",
                marginBottom: "-1px",
                cursor: "pointer",
                font: "inherit",
                fontSize: "var(--font-size-sm)",
                fontWeight: "var(--font-weight-medium)",
                color: activeTab === section.id ? "var(--fg-primary)" : "var(--fg-muted)",
                transition: "color 150ms ease",
                whiteSpace: "nowrap",
              }}
            >
              {activeTab === section.id && (
                <motion.span
                  layoutId={`tab-indicator-${tabLayoutId}`}
                  style={{
                    position: "absolute",
                    bottom: 0,
                    left: 0,
                    right: 0,
                    height: 2,
                    background: "var(--fg-muted)",
                    borderRadius: 1,
                  }}
                  transition={{ type: "spring", stiffness: 400, damping: 30, mass: 0.8 }}
                />
              )}
              {section.label}
            </button>
          ))}
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
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            onClick={() => scrollTo(section.ref)}
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
            {section.label}
          </button>
        ))}
      </nav>

      <div
        className="settings-content"
        style={{ overflow: "auto", minHeight: 0 }}
      >
        {sections.map((section, i) => (
          <section
            key={section.id}
            id={`settings-${section.id}`}
            ref={section.ref}
            style={{
              scrollMarginTop: "var(--space-3)",
              marginBottom: i < sections.length - 1 ? "var(--space-7)" : 0,
            }}
          >
            {section.content}
          </section>
        ))}
      </div>
    </div>
  );
}
