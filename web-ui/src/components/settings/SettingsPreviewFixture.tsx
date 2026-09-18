import { themeById } from "@/theme/registry";
import { DiffView } from "@/components/preview/DiffView";
import { MarkdownView } from "@/components/preview/MarkdownView";

interface SettingsPreviewFixtureProps {
  /** The theme id to preview (the hovered swatch, or the committed theme). */
  themeId: string;
}

const FIXTURE_OLD = `function login(user) {
  if (user.token) {
    return session.create(user);
  }
}`;

const FIXTURE_NEW = `function login(user) {
  if (user?.token) {
    return session.create(user);
  }
}`;

const FIXTURE_MARKDOWN = `# Heading 1 sample

## Heading 2 sample

### Heading 3 sample

Body copy with **bold text**, _italic text_, and \`inline code\`.

> A sample blockquote line.

\`\`\`ts
function greet(name: string) {
  return \`hi \${name}\`;
}
\`\`\`

[A sample link](#)`;

/**
 * Fixed fixture content used by the Appearance (theme picker) live preview.
 * Rendered via the REAL `DiffView`/`MarkdownView` components so the preview
 * never drifts from actual output — not a bespoke preview renderer.
 *
 * The wrapping `.theme-scope[data-theme=...]` (set by the caller) applies the
 * hovered theme's CSS custom properties within this subtree only, so chrome +
 * Markdown colors reflect the previewed theme without touching the root
 * `document.documentElement` attributes. `DiffView` gets the previewed theme's
 * appearance via `themeMode` so its Shiki highlighting matches too.
 */
export function SettingsPreviewFixture({ themeId }: SettingsPreviewFixtureProps) {
  const entry = themeById[themeId] ?? themeById["vibestation-dark"]!;
  const appearance = entry.appearance;

  return (
    <div
      className="settings-preview-fixture"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
        fontSize: "var(--font-size-xs)",
        color: "var(--fg-primary)",
      }}
    >
      <div
        style={{
          background: "var(--bg-card)",
          border: "var(--border-width) solid var(--border-default)",
          borderRadius: "var(--radius-md)",
          padding: "var(--space-2) var(--space-3)",
        }}
      >
        <span style={{ fontWeight: "var(--font-weight-medium)", color: "var(--chat-accent)" }}>
          Agent:
        </span>{" "}
        Fixed the null check in auth.ts — here's the diff:
      </div>

      <div
        style={{
          border: "var(--border-width) solid var(--border-default)",
          borderRadius: "var(--radius-md)",
          overflow: "hidden",
        }}
      >
        <DiffView oldText={FIXTURE_OLD} newText={FIXTURE_NEW} filePath="auth.ts" themeMode={appearance} />
      </div>

      <div
        style={{
          background: "var(--bg-card)",
          border: "var(--border-width) solid var(--border-default)",
          borderRadius: "var(--radius-md)",
          padding: "var(--space-2) var(--space-3)",
        }}
      >
        <MarkdownView source={FIXTURE_MARKDOWN} />
      </div>
    </div>
  );
}
