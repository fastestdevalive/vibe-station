import { useEffect, useRef, useState } from "react";
import type { FileScope } from "@/api/types";
import {
  getHover,
  getLspStatus,
  restartLsp,
  type LspAction,
  type LspFailure,
  type LspSeverity,
  type LspStatus,
} from "@/lib/lspApi";

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
  /** Server is up but reported a health warning (results may be incomplete),
   *  e.g. rust-analyzer's "Failed to read Cargo metadata…". Warning-level
   *  only — an info-level note is `info`, and must never read as impaired. */
  degraded: string | null;
  /** Info-level note about a healthy server (e.g. "Using TypeScript 5.9.3
   *  (global) — …"). Shown in the status tooltip/popup only, never as a chip. */
  info: string | null;
  /** Why the server is not up, with its remediation actions. */
  failure: LspFailure | null;
  onClick: () => Promise<void>;
  /** Clear the daemon's latched failure and respawn, then re-poll. */
  retry: () => Promise<void>;
  /** Re-poll now (e.g. right after a query completes, so a status that
   *  changed since the last 5s tick isn't shown stale). */
  refresh: () => Promise<void>;
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
  const [degraded, setDegraded] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [failure, setFailure] = useState<LspFailure | null>(null);

  const applyResult = (res: Awaited<ReturnType<typeof getLspStatus>> | null) => {
    setStatus(res?.status ?? null);
    setLanguage(res?.language ?? null);
    setDisplayName(res?.displayName ?? null);
    setLabel(res?.label ?? null);
    setSeverity(res?.severity ?? null);
    setText(res?.detail ?? null);
    setAction(res?.action ?? null);
    setActionLabel(res?.actionLabel ?? null);
    const isInfo = res?.degraded?.level === "info";
    setDegraded(isInfo ? null : (res?.degraded?.message ?? null));
    setInfo(isInfo ? (res?.degraded?.message ?? null) : null);
    setFailure(res?.failure ?? null);
  };

  // Identity of the file being polled — an on-demand re-poll (retry/refresh)
  // that resolves after the file changed must not overwrite its status.
  const targetKey = `${scope}|${worktreeId ?? ""}|${path ?? ""}`;
  const targetKeyRef = useRef(targetKey);
  useEffect(() => {
    targetKeyRef.current = targetKey;
  }, [targetKey]);

  const checkStatus = async () => {
    if (!api || !worktreeId || !path) return;
    const key = targetKey;
    try {
      const res = await getLspStatus(api, scope, worktreeId, path);
      if (targetKeyRef.current === key) applyResult(res);
    } catch {
      if (targetKeyRef.current === key) applyResult(null);
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
  const retry = async () => {
    if (!api || !worktreeId || !language) return;
    try {
      await restartLsp(api, scope, worktreeId, language);
    } catch {
      // Ignored: the re-poll below reports whatever state the server is in.
    }
    await checkStatus();
  };

  const onClick = async () => {
    if (!action || !path || !worktreeId) return;
    if (action === "retry") {
      await retry();
      return;
    }
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

  return {
    status,
    language,
    displayName,
    label,
    severity,
    text,
    action,
    actionLabel,
    degraded,
    info,
    failure,
    onClick,
    retry,
    refresh: checkStatus,
  };
}
