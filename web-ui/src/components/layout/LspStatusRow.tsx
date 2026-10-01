import { useEffect, useRef, useState } from "react";
import { useEventTargets } from "@/context/DemoEnv";
import type { FileScope } from "@/api/types";
import { getLspStatuses, type LspLanguageStatus, type LspSeverity } from "@/lib/lspApi";
import { usePreviewedPath } from "@/hooks/usePreviewedPath";
import { useLspStatus } from "@/hooks/useLspStatus";

interface LspStatusRowProps {
  /** Untyped, like `useLspStatus`'s own `api` param — this component never
   *  touches the client directly, it only forwards it to the hook. */
  api: unknown;
  worktreeId: string | null;
  scope?: FileScope;
}

/** Severity -> dot color. Only 4 entries — label/displayName/detail/action text
 *  all come from the backend now (`vst_lsp::status::describe`), so this is the
 *  only status-shaped map left on the frontend (see the `lsp-status-fixes`
 *  plan's Decision 4, `.vibekit/feature-plans/wip/lsp-status-fixes/`). */
const SEVERITY_DOT_CLASS: Record<LspSeverity, string> = {
  ok: "lsp-status-row__dot--green",
  warn: "lsp-status-row__dot--yellow",
  error: "lsp-status-row__dot--red",
  neutral: "lsp-status-row__dot--gray",
};

/**
 * Global, VS Code-style status-bar row for the LSP status of whatever file
 * is currently previewed. Rendered by `GlobalStatusBar` (the bottom bar).
 */
export function LspStatusRow({ api, worktreeId, scope = "worktree" }: LspStatusRowProps) {
  const { doc } = useEventTargets();
  const { path } = usePreviewedPath(worktreeId, scope);
  const { status, language, displayName, label, severity, text, action, actionLabel, onClick } =
    useLspStatus(api, worktreeId, scope, path);
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
    doc.addEventListener("mousedown", onOutside);
    return () => doc.removeEventListener("mousedown", onOutside);
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

  // `text` (the detail sentence) is always populated by the backend alongside
  // `label`/`severity` (see Decision 4) — no frontend fallback string needed.
  if (!status || !path || !label || !severity || !text) return null;

  const detail = text;
  const barLabel = displayName ? `${displayName} LSP: ${label}` : `LSP: ${label}`;
  const isClickable = action != null;

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
        <span className={`lsp-status-row__dot ${SEVERITY_DOT_CLASS[severity]}`} aria-hidden />
        <span className="lsp-status-row__word">{barLabel}</span>
      </button>
      {open && (
        <div className="lsp-status-row__popup" role="dialog" aria-label="LSP status detail">
          <div className="lsp-status-row__popup-text">{detail}</div>
          {isClickable && (
            <div className="lsp-status-row__popup-actions">
              <button type="button" className="lsp-status-row__popup-action-btn" onClick={handleAction}>
                {actionLabel}
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
                    <span className={`lsp-status-row__dot ${SEVERITY_DOT_CLASS[entry.severity]}`} aria-hidden />
                    <span>
                      {entry.displayName ?? entry.language}: {entry.label}
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
