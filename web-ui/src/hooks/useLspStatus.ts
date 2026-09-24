import { useEffect, useState } from "react";
import type { FileScope } from "@/api/types";
import { getHover, getLspStatus, type LspStatus } from "@/lib/lspApi";
import { displayLanguageName } from "@/lib/lspLanguage";

export interface UseLspStatusResult {
  status: LspStatus | null;
  language: string | null;
  /**
   * Full human-readable detail text (the existing "LSP: ..." messages), or
   * `null` when there's nothing worth showing yet (e.g. unsupported/not_found
   * before the language is known).
   */
  text: string | null;
  isClickable: boolean;
  /** Tooltip/title text — same as `text` except for the disabled state, which
   *  gets a slightly different explanatory sentence. */
  title: string | null;
  onClick: () => Promise<void>;
}

/**
 * Polls LSP status for `path` every 5s and builds the same human-readable
 * status text/click behavior the inline `LspStatusBadge` used to own
 * directly. Extracted so both `LspStatusBadge` (per-file topbar badge) and
 * `LspStatusRow` (global bottom-of-panel row) share one poll/click/text
 * implementation instead of two copies drifting apart.
 */
export function useLspStatus(
  api: unknown,
  worktreeId: string | null,
  scope: FileScope = "worktree",
  path?: string | null,
): UseLspStatusResult {
  const [status, setStatus] = useState<LspStatus | null>(null);
  const [language, setLanguage] = useState<string | null>(null);

  const checkStatus = async () => {
    if (!api || !worktreeId || !path) return;
    try {
      const res = await getLspStatus(api, scope, worktreeId, path);
      setStatus(res.status);
      setLanguage(res.language);
    } catch {
      setStatus(null);
      setLanguage(null);
    }
  };

  useEffect(() => {
    if (!api || !worktreeId || !path) {
      setStatus(null);
      setLanguage(null);
      return;
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const res = await getLspStatus(api, scope, worktreeId, path);
        if (!cancelled) {
          setStatus(res.status);
          setLanguage(res.language);
        }
      } catch {
        if (!cancelled) {
          setStatus(null);
          setLanguage(null);
        }
      }
    };

    void poll();
    const interval = setInterval(poll, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [api, worktreeId, scope, path]);

  let text: string | null = null;
  if (status === "ready") {
    text = "LSP: ready";
  } else if (status === "starting") {
    text = "LSP: starting…";
  } else if (status === "indexing") {
    text = "LSP: indexing…";
  } else if (status === "unsupported" || status === "not_found") {
    if (language) {
      text = `LSP: not available for ${displayLanguageName(language)} — server not found on host`;
    }
  } else if (status === "idle") {
    text = "LSP: idle";
  } else if (status === "stopped") {
    text = "LSP: stopped — click to resume";
  } else if (status === "disabled") {
    text = "LSP: disabled — click to enable";
  }

  const isClickable = status === "stopped" || status === "idle" || status === "disabled";
  const title = status === "disabled" ? "LSP is disabled for this workspace. Click to enable." : text;

  const onClick = async () => {
    if (!isClickable || !path || !worktreeId) return;
    if (status === "disabled") {
      try {
        const client = api as {
          setWorktreeLspEnabled?: (id: string, enabled: boolean) => Promise<unknown>;
          setProjectLspEnabled?: (id: string, enabled: boolean) => Promise<unknown>;
        };
        if (scope === "project" && typeof client.setProjectLspEnabled === "function") {
          await client.setProjectLspEnabled(worktreeId, true);
        } else if (typeof client.setWorktreeLspEnabled === "function") {
          await client.setWorktreeLspEnabled(worktreeId, true);
        }
      } catch {
        // Ignored
      }
      await checkStatus();
      return;
    }
    try {
      await getHover(api, scope, worktreeId, { kind: "workspace", path }, 0, 0);
    } catch {
      // Ignored: triggers spawn-on-first-request
    }
    await checkStatus();
  };

  return { status, language, text, isClickable, title, onClick };
}
