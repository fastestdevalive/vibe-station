import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import { SectionHeader } from "./SectionHeader";
import { Input } from "../ui/Input";

interface ProjectsSettingProps {
  api: ApiInstance;
}

export function ProjectsSetting({ api }: ProjectsSettingProps) {
  const [defaultProjectsDir, setDefaultProjectsDir] = useState("");
  const [originalDir, setOriginalDir] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load settings on mount
  useEffect(() => {
    void (async () => {
      try {
        const settings = await api.getSettings();
        setDefaultProjectsDir(settings.defaultProjectsDir);
        setOriginalDir(settings.defaultProjectsDir);
      } catch {
        // Settings not available
      }
    })();
  }, [api]);

  async function handleSave() {
    if (!defaultProjectsDir.trim()) {
      setError("Path cannot be empty");
      return;
    }
    if (!defaultProjectsDir.startsWith("/")) {
      setError("Path must be absolute (start with /)");
      return;
    }

    setError(null);
    setIsSaving(true);
    try {
      await api.updateSettings({ defaultProjectsDir });
      setOriginalDir(defaultProjectsDir);
      setIsEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }

  function handleCancel() {
    setDefaultProjectsDir(originalDir);
    setIsEditing(false);
    setError(null);
  }

  return (
    <div>
      <SectionHeader
        description="Configure where new projects are created by default."
      />

      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "var(--space-4)",
          padding: "var(--space-3) 0",
        }}
      >
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: "var(--font-size-sm)",
              fontWeight: "var(--font-weight-medium)",
              color: "var(--fg-primary)",
              marginBottom: 4,
            }}
          >
            Default projects directory
          </div>
          <div
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--fg-muted)",
              marginBottom: isEditing ? "var(--space-2)" : 0,
            }}
          >
            New projects will be created in this directory unless you specify another.
          </div>

          {isEditing ? (
            <div>
              <Input
                type="text"
                value={defaultProjectsDir}
                onChange={(e) => setDefaultProjectsDir(e.target.value)}
                placeholder="/home/user/projects"
                style={{ marginBottom: "var(--space-2)" }}
              />
              {error && (
                <div
                  style={{
                    fontSize: "var(--font-size-xs)",
                    color: "var(--fg-error, #e53935)",
                    marginBottom: "var(--space-2)",
                  }}
                >
                  {error}
                </div>
              )}
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => void handleSave()}
                  disabled={isSaving}
                >
                  {isSaving ? "Saving..." : "Save"}
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={handleCancel}
                  disabled={isSaving}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                marginTop: "var(--space-2)",
              }}
            >
              <code
                style={{
                  fontSize: "var(--font-size-sm)",
                  color: "var(--fg-primary)",
                  background: "var(--bg-card)",
                  padding: "var(--space-1) var(--space-2)",
                  borderRadius: "var(--radius-sm)",
                  border: "var(--border-width) solid var(--border-subtle, var(--border-default))",
                }}
              >
                {defaultProjectsDir || "~/projects"}
              </code>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => setIsEditing(true)}
              >
                Edit
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
