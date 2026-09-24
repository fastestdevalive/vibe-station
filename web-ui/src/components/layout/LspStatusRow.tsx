import { useEffect, useRef, useState } from "react";
import type { FileScope } from "@/api/types";
import { getLspStatuses, type LspLanguageStatus, type LspStatus } from "@/lib/lspApi";
import { displayLanguageName } from "@/lib/lspLanguage";
import { usePreviewedPath } from "@/hooks/usePreviewedPath";
import { useLspStatus } from "@/hooks/useLspStatus";

interface LspStatusRowProps {
  /** Untyped, like `useLspStatus`'s own `api` param — this component never
   *  touches the client directly, it only forwards it to the hook. */
  api: unknown;
  worktreeId: string | null;
  scope?: FileScope;
}

/** One-word status, VS Code status-bar style — the full sentence still lives
 *  in the popup (reused from `useLspStatus`'s `text`/`title`), this is just
 *  the always-visible label. */
const STATUS_WORD: Record<LspStatus, string> = {
  ready: "Ready",
  starting: "Starting",
  indexing: "Indexing",
  idle: "Idle",
  stopped: "Stopped",
  disabled: "Disabled",
  not_found: "Unavailable",
  unsupported: "N/A",
  error: "Error",
};

const STATUS_DOT_MOD: Record<LspStatus, string> = {
  ready: "lsp-status-row__dot--green",
  starting: "lsp-status-row__dot--yellow",
  indexing: "lsp-status-row__dot--yellow",
  idle: "lsp-status-row__dot--gray",
  stopped: "lsp-status-row__dot--gray",
  disabled: "lsp-status-row__dot--gray",
  not_found: "lsp-status-row__dot--gray",
  unsupported: "lsp-status-row__dot--gray",
  error: "lsp-status-row__dot--red",
};

/**
 * Global, VS Code-style status-bar row for the LSP status of whatever file
 * is currently previewed — lives at the bottom of `ToolPanel`, below
 * `.tool-panel__body`, so it stays visible regardless of which tool tab
 * (Files/Devices/Artifacts/VCS) is active. Replaces the old per-file
 * `LspStatusBadge` that only showed up inside the Files tab's topbar (and,
 * per Task 1, could squeeze the open-file tab strip down to nothing when its
 * text got long — see the CSS fix on `.lsp-status-badge`).
 */
export function LspStatusRow({ api, worktreeId, scope = "worktree" }: LspStatusRowProps) {
  const { path } = usePreviewedPath(worktreeId, scope);
  const { status, language, text, isClickable, title, onClick } = useLspStatus(api, worktreeId, scope, path);
  const [open, setOpen] = useState(false);
  const [allStatuses, setAllStatuses] = useState<LspLanguageStatus[] | null>(null);
  const [statusesLoading, setStatusesLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  // Close the popup whenever the underlying file/status changes out from
  // under it, rather than leaving a stale detail panel open.
  useEffect(() => {
    setOpen(false);
  }, [path, status]);

  // Fetch the "all languages" breakdown only while the popup is open — this
  // is a tap-triggered detail view, no need to poll it in the background.
  useEffect(() => {
    if (!open || !worktreeId) {
      setAllStatuses(null);
      return;
    }
    let cancelled = false;
    setStatusesLoading(true);
    getLspStatuses(api, scope, worktreeId)
      .then((statuses) => {
        if (!cancelled) setAllStatuses(statuses);
      })
      .catch(() => {
        if (!cancelled) setAllStatuses([]);
      })
      .finally(() => {
        if (!cancelled) setStatusesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, api, worktreeId, scope]);

  if (!status || !path) return null;

  const word = STATUS_WORD[status];
  const detail = text ?? title ?? `LSP: ${word}`;
  const barLabel = language ? `${displayLanguageName(language)} LSP: ${word}` : `LSP: ${word}`;

  const handleAction = async () => {
    await onClick();
  };

  return (
    <div className="lsp-status-row" ref={rootRef}>
      <button
        type="button"
        className="lsp-status-row__trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={detail}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`lsp-status-row__dot ${STATUS_DOT_MOD[status]}`} aria-hidden />
        <span className="lsp-status-row__word">{barLabel}</span>
      </button>
      {open && (
        <div className="lsp-status-row__popup" role="dialog" aria-label="LSP status detail">
          <div className="lsp-status-row__popup-text">{detail}</div>
          {isClickable && (
            <div className="lsp-status-row__popup-actions">
              <button type="button" className="lsp-status-row__popup-action-btn" onClick={handleAction}>
                {status === "disabled" ? "Enable" : "Resume"}
              </button>
            </div>
          )}
          <div className="lsp-status-row__popup-languages">
            {statusesLoading ? (
              <div className="lsp-status-row__popup-loading">Loading…</div>
            ) : (
              allStatuses?.map((entry) => {
                const isCurrent = entry.language === language;
                return (
                  <div
                    key={entry.language}
                    className={
                      isCurrent
                        ? "lsp-status-row__popup-lang-row lsp-status-row__popup-lang-row--current"
                        : "lsp-status-row__popup-lang-row"
                    }
                  >
                    <span className={`lsp-status-row__dot ${STATUS_DOT_MOD[entry.status]}`} aria-hidden />
                    <span>
                      {displayLanguageName(entry.language)}: {STATUS_WORD[entry.status]}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
