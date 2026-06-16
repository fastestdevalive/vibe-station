import { useMemo, useState } from "react";
import { Eye } from "lucide-react";
import type { ApiInstance } from "@/api";
import { useServerStore } from "@/hooks/useServerStore";
import { SectionHeader } from "./SectionHeader";

interface HiddenProjectsSettingProps {
  api: ApiInstance;
}

/**
 * Lists projects the user has hidden from the sidebar + dashboard, with a
 * per-row Unhide action. Hidden state is server-side (project manifest), so the
 * list stays in sync via the `project:updated` WS event (no manual refetch).
 */
export function HiddenProjectsSetting({ api }: HiddenProjectsSettingProps) {
  const projects = useServerStore((s) => s.projects);
  const hidden = useMemo(() => projects.filter((p) => p.hidden), [projects]);
  // Track in-flight unhide calls to disable the button + avoid double-fires.
  const [busy, setBusy] = useState<Set<string>>(new Set());

  function unhide(id: string) {
    setBusy((prev) => new Set(prev).add(id));
    void (async () => {
      try {
        await api.unhideProject(id);
        // Store stays current via the `project:updated` WS event; the row drops
        // out of `hidden` on the next render.
      } catch {
        /* surface errors later */
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    })();
  }

  return (
    <div>
      <SectionHeader
        description="Projects you've hidden from the sidebar and dashboard. Unhiding restores a project and all its worktrees."
      />

      {hidden.length === 0 ? (
        <div
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--fg-muted)",
            padding: "var(--space-3) 0",
          }}
        >
          No hidden projects.
        </div>
      ) : (
        <div>
          {hidden.map((p) => (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "var(--space-4)",
                padding: "var(--space-3) 0",
                borderBottom:
                  "var(--border-width) solid var(--border-subtle, var(--border-default))",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: "var(--font-size-sm)",
                    fontWeight: "var(--font-weight-medium)",
                    color: "var(--fg-primary)",
                    marginBottom: 2,
                  }}
                >
                  {p.name}
                </div>
                <div
                  style={{
                    fontSize: "var(--font-size-xs)",
                    color: "var(--fg-muted)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={p.path}
                >
                  {p.path}
                </div>
              </div>
              <button
                type="button"
                disabled={busy.has(p.id)}
                aria-label={`Unhide project ${p.name}`}
                onClick={() => unhide(p.id)}
                style={{
                  flexShrink: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "var(--space-2)",
                  height: "var(--space-7, 32px)",
                  padding: "0 var(--space-3)",
                  lineHeight: 1,
                  whiteSpace: "nowrap",
                  fontSize: "var(--font-size-sm)",
                  fontWeight: "var(--font-weight-medium)",
                  fontFamily: "inherit",
                  border: "var(--border-width) solid var(--border-default)",
                  borderRadius: "var(--radius-md)",
                  background: "var(--bg-surface, var(--bg-card))",
                  color: "var(--fg-primary)",
                  cursor: busy.has(p.id) ? "default" : "pointer",
                  opacity: busy.has(p.id) ? 0.6 : 1,
                }}
              >
                <Eye size={14} aria-hidden style={{ flexShrink: 0 }} />
                <span>Unhide</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
