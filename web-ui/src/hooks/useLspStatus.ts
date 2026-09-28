import { useEffect, useState } from "react";
import type { FileScope } from "@/api/types";
import { getHover, getLspStatus, type LspAction, type LspSeverity, type LspStatus } from "@/lib/lspApi";

export interface UseLspStatusResult {
  status: LspStatus | null;
  language: string | null;
  /** Human display name for `language` (e.g. "TypeScript / JavaScript"), computed
   *  server-side by `vst_lsp::status::describe` — never re-derived here. */
  displayName: string | null;
  /** One-word label (e.g. "Ready", "Starting"), computed server-side. */
  label: string | null;
  /** Dot-color severity, computed server-side. */
  severity: LspSeverity | null;
  /** Full human-readable detail sentence (the "LSP: ..." messages), computed
   *  server-side — always non-null once a status has loaded. */
  text: string | null;
  /** Machine-readable click action, or `null` when not clickable. */
  action: LspAction | null;
  /** Button text for `action` — presentation only, never compared for dispatch. */
  actionLabel: string | null;
  onClick: () => Promise<void>;
}

/**
 * Polls LSP status for `path` every 5s and passes through the backend's
 * presentation fields (label/displayName/severity/detail/action/actionLabel)
 * unchanged. Shared by `LspStatusRow` (global bottom-of-panel row and the
 * tools-pane side panel instance) so both poll/click/render the same way.
 */
export function useLspStatus(
  api: unknown,
  worktreeId: string | null,
  scope: FileScope = "worktree",
  path?: string | null,
): UseLspStatusResult {
  const [status, setStatus] = useState<LspStatus | null>(null);
  const [language, setLanguage] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [severity, setSeverity] = useState<LspSeverity | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [action, setAction] = useState<LspAction | null>(null);
  const [actionLabel, setActionLabel] = useState<string | null>(null);

  const applyResult = (res: Awaited<ReturnType<typeof getLspStatus>> | null) => {
    setStatus(res?.status ?? null);
    setLanguage(res?.language ?? null);
    setDisplayName(res?.displayName ?? null);
    setLabel(res?.label ?? null);
    setSeverity(res?.severity ?? null);
    setText(res?.detail ?? null);
    setAction(res?.action ?? null);
    setActionLabel(res?.actionLabel ?? null);
  };

  const checkStatus = async () => {
    if (!api || !worktreeId || !path) return;
    try {
      const res = await getLspStatus(api, scope, worktreeId, path);
      applyResult(res);
    } catch {
      applyResult(null);
    }
  };

  useEffect(() => {
    if (!api || !worktreeId || !path) {
      applyResult(null);
      return;
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const res = await getLspStatus(api, scope, worktreeId, path);
        if (!cancelled) applyResult(res);
      } catch {
        if (!cancelled) applyResult(null);
      }
    };

    void poll();
    const interval = setInterval(poll, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [api, worktreeId, scope, path]);

  // `action` (machine-readable) decides the dispatch target. `actionLabel` (human
  // text) is rendered on the button only — never compared. The two client calls
  // below are mechanics (which endpoint to hit), not presentation — they stay
  // client-side.
  const onClick = async () => {
    if (!action || !path || !worktreeId) return;
    if (action === "enable") {
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
    // action === "resume" (stopped/idle) — unchanged getHover spawn-trigger call
    try {
      await getHover(api, scope, worktreeId, { kind: "workspace", path }, 0, 0);
    } catch {
      // Ignored: triggers spawn-on-first-request
    }
    await checkStatus();
  };

  return { status, language, displayName, label, severity, text, action, actionLabel, onClick };
}
