import { useCallback, useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { LspLanguageSurveyEntry } from "@/api/types";
import { copyText } from "@/lib/copyText";
import { SectionHeader } from "./SectionHeader";

interface LspSettingProps {
  api: ApiInstance;
}

function LspRow({ entry }: { entry: LspLanguageSurveyEntry }) {
  const [copied, setCopied] = useState(false);

  const missing = !entry.installedOnHost;

  function handleCopy() {
    if (!entry.installCommand) return;
    void copyText(entry.installCommand).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: "var(--space-4)",
        padding: "var(--space-3) 0",
        borderBottom:
          "var(--border-width) solid var(--border-subtle, var(--border-default))",
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: 2 }}>
          <span
            style={{
              fontSize: "var(--font-size-sm)",
              fontWeight: "var(--font-weight-medium)",
              color: "var(--fg-primary)",
            }}
          >
            {entry.displayName}
          </span>
          <span
            style={{
              fontSize: "var(--font-size-xs)",
              padding: "1px var(--space-2)",
              borderRadius: "var(--radius-sm)",
              color: missing ? "var(--fg-danger)" : "var(--fg-success)",
              background: missing
                ? "var(--bg-danger-subtle, var(--bg-input))"
                : "var(--bg-success-subtle, var(--bg-input))",
            }}
          >
            {missing ? "Missing" : "Installed"}
          </span>
        </div>
        {missing && entry.installCommand && (
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginTop: "var(--space-1)" }}>
            <code
              style={{
                fontSize: "var(--font-size-xs)",
                color: "var(--fg-primary)",
                background: "var(--bg-input)",
                border: "var(--border-width) solid var(--border-default)",
                borderRadius: "var(--radius-sm)",
                padding: "2px var(--space-2)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: "100%",
              }}
            >
              {entry.installCommand}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              style={{
                flexShrink: 0,
                fontSize: "var(--font-size-xs)",
                fontFamily: "inherit",
                lineHeight: 1,
                padding: "4px var(--space-3)",
                border: "var(--border-width) solid var(--border-default)",
                borderRadius: "var(--radius-md)",
                background: "var(--bg-surface, var(--bg-card))",
                color: "var(--fg-primary)",
                cursor: "pointer",
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
        {missing && entry.installNote && (
          <div
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--fg-muted)",
              marginTop: entry.installCommand ? "var(--space-1)" : "var(--space-1)",
              lineHeight: 1.5,
            }}
          >
            {entry.installNote}
          </div>
        )}
      </div>
    </div>
  );
}

export function LspSetting({ api }: LspSettingProps) {
  const [languages, setLanguages] = useState<LspLanguageSurveyEntry[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api.getLspLanguages();
      setLanguages(res.languages);
      setLoadFailed(false);
    } catch {
      // A failed load must not render as the (identical-looking) "all missing"
      // list — say so instead of swallowing it.
      setLoadFailed(true);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sorted = languages
    ? [...languages].sort((a, b) => {
        if (a.installedOnHost !== b.installedOnHost) return a.installedOnHost ? 1 : -1;
        return a.displayName.localeCompare(b.displayName);
      })
    : [];

  return (
    <div>
      <SectionHeader
        title="LSP"
        description="Language server availability on the daemon host. Missing servers show a copy-pasteable install command where one exists."
      />

      {loadFailed ? (
        <div
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--destructive)",
            padding: "var(--space-3) 0",
          }}
        >
          Failed to load LSP language status.
        </div>
      ) : languages === null ? (
        <div
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--fg-muted)",
            padding: "var(--space-3) 0",
          }}
        >
          Loading LSP language status…
        </div>
      ) : (
        <div>
          {sorted.map((entry) => (
            <LspRow key={entry.language} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}
