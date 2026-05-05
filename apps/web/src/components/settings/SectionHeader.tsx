/**
 * Shared section header for settings panels.
 * Matches the design system's web-settings-section-title + web-settings-section-desc pattern.
 */
export function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div style={{ marginBottom: "var(--space-4)" }}>
      <div
        style={{
          fontSize: "var(--font-size-base)",
          fontWeight: "var(--font-weight-semibold)",
          color: "var(--fg-primary)",
          marginBottom: description ? "var(--space-1)" : 0,
        }}
      >
        {title}
      </div>
      {description && (
        <div
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--fg-muted)",
            lineHeight: 1.5,
          }}
        >
          {description}
        </div>
      )}
    </div>
  );
}
