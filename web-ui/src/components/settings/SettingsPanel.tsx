import { useId, useState } from "react";
import { motion } from "framer-motion";
import type { ApiInstance } from "@/api";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { ModesSetting } from "./ModesSetting";
import { AppearanceSetting } from "./AppearanceSetting";
import { ProjectsSetting } from "./ProjectsSetting";
import { HiddenProjectsSetting } from "./HiddenProjectsSetting";
import { StorageSetting } from "./StorageSetting";

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
  const [activeTab, setActiveTab] = useState("modes");
  const tabLayoutId = useId();

  const sections: Section[] = [
    {
      id: "modes",
      label: "Modes",
      content: <ModesSetting api={api} />,
    },
    {
      id: "appearance",
      label: "Appearance",
      content: <AppearanceSetting />,
    },
    {
      id: "projects",
      label: "Projects",
      content: <ProjectsSetting api={api} />,
    },
    {
      id: "hidden-projects",
      label: "Hidden projects",
      content: <HiddenProjectsSetting api={api} />,
    },
    {
      id: "storage",
      label: "Storage",
      content: <StorageSetting api={api} />,
    },
  ];

  const activeSection = sections.find((s) => s.id === activeTab) ?? sections[0]!;

  // ── Mobile: underline tabs ───────────────────────────────────────────────
  if (isMobile) {
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
        <div
          role="tablist"
          style={{
            flexShrink: 0,
            display: "flex",
            gap: "var(--space-1)",
            borderBottom: "var(--border-width) solid var(--border-default)",
            padding: "0 var(--space-3)",
            overflowX: "auto",
            WebkitOverflowScrolling: "touch",
            scrollbarWidth: "none",
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

  // ── Desktop: side nav + active section only ──────────────────────────────
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
            onClick={() => setActiveTab(section.id)}
            className="settings-nav__link"
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "var(--space-2) var(--space-3)",
              borderRadius: "var(--radius-sm)",
              border: "none",
              background: activeTab === section.id ? "var(--bg-hover)" : "transparent",
              color: "var(--fg-primary)",
              cursor: "pointer",
              font: "inherit",
              fontWeight:
                activeTab === section.id
                  ? "var(--font-weight-medium)"
                  : "var(--font-weight-normal)",
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
        {activeSection.content}
      </div>
    </div>
  );
}
