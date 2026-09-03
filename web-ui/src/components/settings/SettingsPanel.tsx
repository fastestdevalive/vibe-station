import { useId } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import type { ApiInstance } from "@/api";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { ModesSetting } from "./ModesSetting";
import { AppearanceSetting } from "./AppearanceSetting";
import { ProjectsSetting } from "./ProjectsSetting";
import { SkillsSetting } from "./SkillsSetting";
import { HiddenProjectsSetting } from "./HiddenProjectsSetting";
import { StorageSetting } from "./StorageSetting";
import { RemoteAccessSetting } from "./RemoteAccessSetting";

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
  const navigate = useNavigate();
  const { sectionId } = useParams<{ sectionId?: string }>();
  const tabLayoutId = useId();

  const sections: Section[] = [
    { id: "modes", label: "Modes", content: <ModesSetting api={api} /> },
    { id: "appearance", label: "Appearance", content: <AppearanceSetting /> },
    { id: "projects", label: "Projects", content: <ProjectsSetting api={api} /> },
    { id: "skills", label: "Skills", content: <SkillsSetting api={api} /> },
    { id: "hidden-projects", label: "Hidden projects", content: <HiddenProjectsSetting api={api} /> },
    { id: "storage", label: "Storage", content: <StorageSetting api={api} /> },
    { id: "remote-access", label: "Remote Access", content: <RemoteAccessSetting api={api} /> },
  ];

  const activeSection = sections.find((s) => s.id === sectionId) ?? sections[0]!;
  const activeId = activeSection.id;

  // Desktop sidebar: swap the section without stacking a history entry, so
  // browser Back leaves settings instead of walking back through the tabs.
  function goTo(id: string) {
    navigate(`/settings/${id}`, { replace: true });
  }

  // Mobile list → section: push, so the phone's Back gesture returns to the list.
  function pushTo(id: string) {
    navigate(`/settings/${id}`);
  }

  // ── Mobile: list → detail with back button ───────────────────────────────
  if (isMobile) {
    // No section selected → show the vertical list
    if (!sectionId) {
      return (
        <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div
            style={{
              padding: "var(--space-3) var(--space-4)",
              borderBottom: "var(--border-width) solid var(--border-default)",
              fontSize: "12px",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "var(--fg-muted)",
              flexShrink: 0,
            }}
          >
            Settings
          </div>
          <div style={{ flex: 1, overflow: "auto" }}>
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => pushTo(section.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                  padding: "var(--space-4) var(--space-4)",
                  border: "none",
                  borderBottom: "var(--border-width) solid var(--border-default)",
                  background: "transparent",
                  color: "var(--fg-primary)",
                  cursor: "pointer",
                  font: "inherit",
                  fontSize: "var(--font-size-sm)",
                  textAlign: "left",
                }}
              >
                {section.label}
                <span style={{ color: "var(--fg-muted)", fontSize: "var(--font-size-xs)" }}>›</span>
              </button>
            ))}
          </div>
        </div>
      );
    }

    // Section selected → content only; back button and breadcrumb live in TopBar
    return (
      <div style={{ height: "100%", overflow: "auto", padding: "var(--space-3)" }}>
        {activeSection.content}
      </div>
    );
  }

  // ── Desktop: side nav + content ──────────────────────────────────────────
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
            onClick={() => goTo(section.id)}
            className="settings-nav__link"
            style={{
              position: "relative",
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "var(--space-2) var(--space-3)",
              borderRadius: "var(--radius-sm)",
              border: "none",
              background: "transparent",
              color: activeId === section.id ? "var(--fg-primary)" : "var(--fg-muted)",
              cursor: "pointer",
              font: "inherit",
              fontWeight: activeId === section.id ? "var(--font-weight-medium)" : "var(--font-weight-normal)",
            }}
          >
            {activeId === section.id && (
              <motion.span
                layoutId={`settings-indicator-${tabLayoutId}`}
                style={{
                  position: "absolute",
                  inset: 0,
                  borderRadius: "var(--radius-sm)",
                  background: "var(--bg-hover)",
                  zIndex: 0,
                }}
                transition={{ type: "spring", stiffness: 400, damping: 30, mass: 0.8 }}
              />
            )}
            <span style={{ position: "relative", zIndex: 1 }}>{section.label}</span>
          </button>
        ))}
      </nav>

      <div className="settings-content" style={{ overflow: "auto", minHeight: 0 }}>
        {activeSection.content}
      </div>
    </div>
  );
}
