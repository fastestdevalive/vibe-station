import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { SkillDirectory } from "@/api/types";
import { SectionHeader } from "./SectionHeader";
import { Input } from "../ui/Input";

interface SkillsSettingProps {
  api: ApiInstance;
}

/**
 * Directory list + add/remove form for `skillPaths` (skill-invocation-in-chat
 * 4.7) — the directories `userSkillCatalog` scans for `<dir>/*\/SKILL.md`
 * user skills. `directories[].skillCount`/`.error` come from `GET /skills`;
 * the path list itself is persisted via `PATCH /settings`.
 */
export function SkillsSetting({ api }: SkillsSettingProps) {
  const [skillPaths, setSkillPaths] = useState<string[]>([]);
  const [directories, setDirectories] = useState<SkillDirectory[]>([]);
  const [newPath, setNewPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [settings, skills] = await Promise.all([api.getSettings(), api.getSkills()]);
      setSkillPaths(settings.skillPaths ?? []);
      setDirectories(skills.directories);
      setLoadFailed(false);
    } catch {
      // A failed load must not render as the (identical-looking) "no
      // directories configured" empty state — say so instead of swallowing it.
      setLoadFailed(true);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function addPath() {
    const path = newPath.trim();
    if (!path) return;
    if (!path.startsWith("/")) {
      setError("Path must be absolute (start with /)");
      return;
    }
    if (skillPaths.includes(path)) {
      setError("Directory already added");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const next = [...skillPaths, path];
      await api.updateSettings({ skillPaths: next });
      setNewPath("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removePath(path: string) {
    setBusy(true);
    try {
      const next = skillPaths.filter((p) => p !== path);
      await api.updateSettings({ skillPaths: next });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function directoryFor(path: string): SkillDirectory | undefined {
    return directories.find((d) => d.path === path);
  }

  return (
    <div>
      <SectionHeader
        description="Directories scanned for user skills (<directory>/<name>/SKILL.md). Skills found here are merged with your agent's own catalog in the chat composer's / popover."
      />

      {loadFailed ? (
        <div
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--destructive)",
            padding: "var(--space-3) 0",
          }}
        >
          Could not load skill settings — is the daemon reachable?
        </div>
      ) : skillPaths.length === 0 ? (
        <div
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--fg-muted)",
            padding: "var(--space-3) 0",
          }}
        >
          No skill directories configured.
        </div>
      ) : (
        <div>
          {skillPaths.map((path) => {
            const dir = directoryFor(path);
            return (
              <div
                key={path}
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
                  <code
                    style={{
                      fontSize: "var(--font-size-sm)",
                      color: "var(--fg-primary)",
                    }}
                  >
                    {path}
                  </code>
                  <div
                    style={{
                      fontSize: "var(--font-size-xs)",
                      color: dir?.error ? "var(--destructive)" : "var(--fg-muted)",
                      marginTop: 2,
                      // An absent directory is muted, never red — we ship
                      // defaults for CLIs the user may not have installed.
                      fontStyle: dir?.missing ? "italic" : undefined,
                    }}
                  >
                    {dir?.error ??
                      (dir?.missing
                        ? "not found — will be picked up if created"
                        : `${dir?.skillCount ?? 0} skill${dir?.skillCount === 1 ? "" : "s"}`)}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Remove skill directory ${path}`}
                  onClick={() => void removePath(path)}
                  style={{
                    flexShrink: 0,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    height: "var(--space-7, 32px)",
                    width: "var(--space-7, 32px)",
                    border: "var(--border-width) solid var(--border-default)",
                    borderRadius: "var(--radius-md)",
                    background: "var(--bg-surface, var(--bg-card))",
                    color: "var(--fg-primary)",
                    cursor: busy ? "default" : "pointer",
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  <X size={14} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: "var(--space-2)",
          marginTop: "var(--space-3)",
          alignItems: "flex-start",
        }}
      >
        <Input
          type="text"
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          placeholder="/home/user/.claude/skills"
          onKeyDown={(e) => {
            if (e.key === "Enter") void addPath();
          }}
        />
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={busy}
          onClick={() => void addPath()}
        >
          Add
        </button>
      </div>
      {error && (
        <div
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--destructive)",
            marginTop: "var(--space-2)",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
