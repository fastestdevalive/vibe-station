import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useEventTargets } from "@/context/DemoEnv";
import type { FileScope, LspLanguageSurveyEntry, LspLanguageSurveyResponse } from "@/api/types";
import {
  getLspStatuses,
  restartLsp,
  type LspFailure,
  type LspLanguageStatus,
  type LspSeverity,
  type LspStatus,
} from "@/lib/lspApi";
import { usePreviewedPath } from "@/hooks/usePreviewedPath";
import { useLspStatus } from "@/hooks/useLspStatus";
import { copyText } from "@/lib/copyText";

interface LspStatusRowProps {
  /** Untyped, like `useLspStatus`'s own `api` param. */
  api: unknown;
  worktreeId: string | null;
  scope?: FileScope;
}

const SEVERITY_DOT_CLASS: Record<LspSeverity, string> = {
  ok: "lsp-status-row__dot--ok",
  warn: "lsp-status-row__dot--warn",
  error: "lsp-status-row__dot--error",
  neutral: "lsp-status-row__dot--off",
};

/** Spinner states: starting/indexing, plus a crash the daemon is auto-restarting. */
function isBusyEntry(s: { status: LspStatus; label?: string | null }): boolean {
  return s.status === "starting" || s.status === "indexing" || s.label === "Restarting";
}

/** Severity sort weight: error (0), warn (1), busy (2), neutral (3), ok (4). */
function severityWeight(s: { status: LspStatus; label?: string | null; severity: LspSeverity }): number {
  if (s.severity === "error") return 0;
  if (isBusyEntry(s)) return 2;
  if (s.severity === "warn") return 1;
  if (s.severity === "neutral") return 3;
  return 4;
}

/** Needs the user's attention: a warn/error that isn't just a transient busy state. */
function needsAttention(s: { status: LspStatus; label?: string | null; severity: LspSeverity }): boolean {
  return (s.severity === "warn" || s.severity === "error") && !isBusyEntry(s);
}

function shortName(displayName: string | null | undefined): string {
  if (!displayName) return "LSP";
  const first = displayName.split(" / ")[0];
  return first ? first.trim() : "LSP";
}

/**
 * Minimal LSP status row & popup v2.
 */
export function LspStatusRow({ api, worktreeId, scope = "worktree" }: LspStatusRowProps) {
  const { doc } = useEventTargets();
  const { path } = usePreviewedPath(worktreeId, scope);
  const {
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
    busy: hookBusy,
    onClick,
    retry,
  } = useLspStatus(api, worktreeId, scope, path);

  const [open, setOpen] = useState(false);
  const [allStatuses, setAllStatuses] = useState<LspLanguageStatus[] | null>(null);
  const [statusesLoading, setStatusesLoading] = useState(false);
  const [statusesError, setStatusesError] = useState(false);

  const [survey, setSurvey] = useState<LspLanguageSurveyEntry[] | null>(null);
  const [notInProjectOpen, setNotInProjectOpen] = useState(false);

  // Selected language in the popup (defaults to active file's language; resets when path changes)
  const [selectedLang, setSelectedLang] = useState<string | null>(null);

  // In-flight action state (disables buttons up to 10s or until status changes)
  const [actionInFlight, setActionInFlight] = useState(false);
  const inFlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Copy install command feedback
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Optional react-router navigate for LSP settings link
  let navigate: ReturnType<typeof useNavigate> | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    navigate = useNavigate();
  } catch {
    navigate = null;
  }

  // Reset selected language and close on path change
  useEffect(() => {
    setSelectedLang(null);
    setOpen(false);
  }, [path]);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    doc.addEventListener("mousedown", onOutside);
    return () => doc.removeEventListener("mousedown", onOutside);
  }, [open, doc]);

  // Esc key closes and refocuses trigger
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore Esc aimed at something else (editor, another modal): only react
      // when focus is inside this row or nowhere in particular.
      const t = e.target as Node;
      const focusIdle = !(t instanceof Element) || t.tagName === "BODY" || t.tagName === "HTML";
      if (e.key === "Escape" && !e.defaultPrevented && (focusIdle || rootRef.current?.contains(t))) {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    doc.addEventListener("keydown", onKeyDown);
    return () => doc.removeEventListener("keydown", onKeyDown);
  }, [open, doc]);

  // Fetch detected statuses on mount, path/status change (the hook's 5s poll
  // drives `status`/`label`, so the list and badge stay fresh), and on open.
  // Each request carries an id so a slow response from a previous worktree or
  // file can never overwrite a newer one.
  const statusesReqRef = useRef(0);
  const fetchStatuses = () => {
    if (!worktreeId) return;
    const req = ++statusesReqRef.current;
    setStatusesLoading(true);
    setStatusesError(false);
    getLspStatuses(api, scope, worktreeId)
      .then((res) => {
        if (req !== statusesReqRef.current) return;
        setAllStatuses(res);
        setStatusesError(false);
      })
      .catch(() => {
        if (req !== statusesReqRef.current) return;
        setStatusesError(true);
      })
      .finally(() => {
        if (req !== statusesReqRef.current) return;
        setStatusesLoading(false);
      });
  };

  // A different worktree/scope invalidates the whole list immediately.
  useEffect(() => {
    statusesReqRef.current++;
    setAllStatuses(null);
    setSelectedLang(null);
  }, [worktreeId, scope]);

  useEffect(() => {
    if (!worktreeId) return;
    fetchStatuses();
  }, [worktreeId, scope, api, path, status, label]);

  useEffect(() => {
    if (open && worktreeId) {
      fetchStatuses();
    }
  }, [open]);

  // Heartbeat: the hook's poll only changes `status`/`label` on a transition, so
  // a language that crashes in the background (or a drilled-in Restart) would
  // never refresh. While the popup is open refresh every 5s; otherwise every
  // 30s keeps the badge honest without re-walking the file tree
  // (`/lsp/statuses` lists the worktree) every 5s.
  useEffect(() => {
    if (!worktreeId || !path) return;
    let ticks = 0;
    const id = setInterval(() => {
      ticks += 1;
      if (open || ticks % 6 === 0) fetchStatuses();
    }, 5000);
    return () => clearInterval(id);
  }, [worktreeId, scope, api, path, open]);

  // Closing the popup forgets any drill-in selection.
  useEffect(() => {
    if (!open) setSelectedLang(null);
  }, [open]);

  // Fetch survey languages on open
  useEffect(() => {
    if (!open) return;
    const client = api as { getLspLanguages?: () => Promise<LspLanguageSurveyResponse> };
    if (client && typeof client.getLspLanguages === "function") {
      client
        .getLspLanguages()
        .then((res) => {
          setSurvey(res.languages);
        })
        .catch(() => {
          setSurvey(null);
        });
    }
  }, [open, api]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (inFlightTimerRef.current) clearTimeout(inFlightTimerRef.current);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      statusesReqRef.current++;
    };
  }, []);

  // Compute other detected languages needing attention for the badge count
  const badgeCount = useMemo(() => {
    if (!allStatuses) return 0;
    return allStatuses.filter((s) => {
      if (s.language === language) return false;
      return needsAttention(s);
    }).length;
  }, [allStatuses, language]);

  // Drill-in selection; picking the current file's own row is "no selection".
  const selected =
    selectedLang &&
    selectedLang !== language &&
    allStatuses?.some((s) => s.language === selectedLang)
      ? selectedLang
      : null;

  // Active language in the popup (either selected language or current file's language)
  const currentLangStatus = useMemo(() => {
    if (selected && allStatuses) {
      const found = allStatuses.find((s) => s.language === selected);
      if (found) return found;
    }
    return {
      status,
      language: language ?? "",
      displayName: displayName ?? null,
      label,
      severity,
      detail: text,
      action,
      actionLabel,
      failure: failure ?? undefined,
    } as LspLanguageStatus;
  }, [selected, allStatuses, status, language, displayName, label, severity, text, action, actionLabel, failure]);

  // Clear the in-flight guard when the ACTIVE language's status changes.
  useEffect(() => {
    setActionInFlight(false);
    if (inFlightTimerRef.current) {
      clearTimeout(inFlightTimerRef.current);
      inFlightTimerRef.current = null;
    }
  }, [currentLangStatus.status, currentLangStatus.label]);

  const activeLangKey = currentLangStatus.language;
  const activeDisplayName = currentLangStatus.displayName ?? (activeLangKey ? activeLangKey : "LSP");
  const activeStatus = currentLangStatus.status;
  const activeSeverity = currentLangStatus.severity;
  const activeLabel = currentLangStatus.label;
  const activeFailure = (currentLangStatus as { failure?: LspFailure | null }).failure ?? (selected == null ? failure : null);

  // "Also in this project" list
  const otherLanguages = useMemo(() => {
    if (!allStatuses) return [];
    return allStatuses
      .filter((s) => s.language !== activeLangKey)
      // On an unsupported file the list is headed "Needs attention" — only show those.
      .filter((s) => !(status === "unsupported" && selected == null) || needsAttention(s))
      .sort((a, b) => {
        const wa = severityWeight(a);
        const wb = severityWeight(b);
        if (wa !== wb) return wa - wb;
        const na = a.displayName ?? a.language;
        const nb = b.displayName ?? b.language;
        return na.localeCompare(nb);
      });
  }, [allStatuses, activeLangKey, status, selected]);

  // "Not in this project (N)" list
  const detectedKeys = useMemo(() => {
    return new Set(allStatuses?.map((s) => s.language) ?? (language ? [language] : []));
  }, [allStatuses, language]);

  const notInProjectLangs = useMemo(() => {
    if (!survey) return [];
    return survey
      .filter((s) => !detectedKeys.has(s.language))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [survey, detectedKeys]);

  // Hidden conditions: no status/path/label/severity/text, or unsupported and badge count 0
  if (!status || !path || !label || !severity || !text) return null;
  // Never vanish mid-interaction: a Restart on a drilled-in language can drop
  // the badge to 0 while the popup is open.
  if (status === "unsupported" && badgeCount === 0 && !open) return null;

  // Trigger values
  const isUnsupportedAttention = status === "unsupported" && badgeCount > 0;
  const triggerName = isUnsupportedAttention
    ? "LSP"
    : status === "disabled"
      ? "LSP off"
      : shortName(displayName);

  // State word
  let triggerStateWord: string | null = null;
  if (status === "ready") {
    if (degraded) {
      triggerStateWord = "Limited";
    }
  } else if (status !== "disabled" && !isUnsupportedAttention) {
    triggerStateWord = label;
  }

  // Trigger icon
  const isBusy = isBusyEntry({ status, label });

  // Trigger badge tone
  const badgeTone = allStatuses?.some((s) => s.language !== language && s.severity === "error")
    ? "error"
    : "warn";

  // Popup header
  const isCurrentUnsupported = !selected && status === "unsupported";
  const headerTitle = isCurrentUnsupported
    ? "No language server for this file type"
    : activeDisplayName;

  const headerWord = isCurrentUnsupported
    ? ""
    : status === "ready" && degraded && !selected
      ? "Limited"
      : activeLabel;

  const isHeaderBusy = isBusyEntry({ status: activeStatus, label: activeLabel });

  const headerIcon = isHeaderBusy
    ? "spin"
    : isCurrentUnsupported
      ? "none"
      : status === "ready" && degraded && !selected
        ? "warn"
        : activeSeverity;

  // Sentence
  const isDegradedView = status === "ready" && !!degraded && !selected;
  const showSentence =
    !isCurrentUnsupported && activeStatus !== "ready" && activeStatus !== "starting";
  const sentenceText = currentLangStatus.detail;

  // Install command resolution
  const copyCommand = activeFailure?.remediation.find((r) => r.kind === "copy_command")?.command;
  const surveyCommand = survey?.find((s) => s.language === activeLangKey)?.installCommand;
  const installCommand = copyCommand ?? (activeStatus === "not_found" ? surveyCommand : null);

  // Server output disclosure
  const serverOutput = activeFailure?.message ?? null;
  const showServerOutput = serverOutput != null && activeLabel !== "Restarting";

  // Action button resolution — one button, driven by the daemon's `action`/`actionLabel`.
  // For a drilled-in (non-current) language only `retry` is actionable: enable/resume
  // dispatch through the current file's path, which says nothing about that language.
  const isActionDisabled = actionInFlight || hookBusy;
  const popupAction =
    selected == null
      ? currentLangStatus.action
      : currentLangStatus.action === "retry"
        ? "retry"
        : null;

  const triggerInFlightTimer = () => {
    setActionInFlight(true);
    if (inFlightTimerRef.current) clearTimeout(inFlightTimerRef.current);
    inFlightTimerRef.current = setTimeout(() => {
      setActionInFlight(false);
    }, 10000);
  };

  const handleActionClick = async () => {
    if (isActionDisabled) return;
    triggerInFlightTimer();
    if (selected == null) {
      await onClick();
    } else if (popupAction === "retry" && worktreeId) {
      try {
        await restartLsp(api, scope, worktreeId, activeLangKey);
      } catch {
        // Ignored: the re-fetch below reports whatever state the server is in.
      }
      fetchStatuses();
    }
    // The action itself has finished; a failure that lands in the same
    // status/label must be retryable without waiting out the 10s cap.
    setActionInFlight(false);
  };

  const handleCopyCommand = async (cmd: string) => {
    if (await copyText(cmd)) {
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="lsp-status-row" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="lsp-status-row__trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={info ? `${text}\n${info}` : text}
        onClick={() => setOpen((o) => !o)}
      >
        {isUnsupportedAttention ? null : isBusy ? (
          <span className="lsp-status-row__spin" aria-hidden />
        ) : (
          <span
            className={`lsp-status-row__dot ${
              status === "ready" && degraded
                ? "lsp-status-row__dot--warn"
                : SEVERITY_DOT_CLASS[severity]
            }`}
            aria-hidden
          />
        )}
        <span className="lsp-status-row__name">{triggerName}</span>
        {triggerStateWord && <span className="lsp-status-row__state">· {triggerStateWord}</span>}
        {badgeCount > 0 && (
          <span
            className={`lsp-status-row__more lsp-status-row__badge lsp-status-row__more--${badgeTone}`}
            aria-label={
              badgeCount === 1
                ? "1 other language needs attention"
                : `${badgeCount} other languages need attention`
            }
          >
            {badgeCount}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={popupRef}
          className="lsp-status-row__popup"
          role="dialog"
          aria-label="LSP status detail"
        >
          {/* Header */}
          <div className="lsp-status-row__head">
            <div className="lsp-status-row__title">
              <b>{headerTitle}</b>
              {headerWord && (
                <span className="lsp-status-row__pill">
                  {headerIcon === "spin" ? (
                    <span className="lsp-status-row__spin" aria-hidden />
                  ) : headerIcon === "none" ? null : (
                    <span
                      className={`lsp-status-row__dot ${
                        headerIcon === "ok"
                          ? "lsp-status-row__dot--ok"
                          : headerIcon === "warn"
                            ? "lsp-status-row__dot--warn"
                            : headerIcon === "error"
                              ? "lsp-status-row__dot--error"
                              : "lsp-status-row__dot--off"
                      }`}
                      aria-hidden
                    />
                  )}
                  {headerWord}
                </span>
              )}
            </div>

            {/* Sentence */}
            {showSentence && sentenceText && (
              <p className="lsp-status-row__sentence">{sentenceText}</p>
            )}

            {/* Degraded warning note */}
            {isDegradedView && <p className="lsp-status-row__note">{degraded}</p>}

            {/* Info note */}
            {info && !selected && <p className="lsp-status-row__note">{info}</p>}
          </div>

          {/* Install command box */}
          {installCommand && (
            <div className="lsp-status-row__cmd">
              <code>{installCommand}</code>
              <button
                type="button"
                title="Copy install command"
                aria-label={copied ? "Copied" : "Copy install command"}
                onClick={() => void handleCopyCommand(installCommand)}
              >
                {copied ? "Copied" : "⧉"}
              </button>
            </div>
          )}

          {/* Action button (at most one) */}
          {popupAction && (
            <div className="lsp-status-row__actions">
              <button
                type="button"
                className={`lsp-status-row__btn${
                  popupAction === "enable" ? " lsp-status-row__btn--primary" : ""
                }`}
                disabled={isActionDisabled}
                onClick={() => void handleActionClick()}
              >
                {currentLangStatus.actionLabel}
              </button>
            </div>
          )}

          {/* Server output disclosure */}
          {showServerOutput && (
            <details className="lsp-status-row__out">
              <summary>Show output</summary>
              <pre>{serverOutput}</pre>
            </details>
          )}

          {/* Also in this project */}
          <div className="lsp-status-row__sec">
            {isCurrentUnsupported ? (
              <h4>Needs attention</h4>
            ) : (
              <h4>Also in this project</h4>
            )}

            {statusesLoading && !allStatuses ? (
              <>
                <div className="lsp-status-row__skel" style={{ width: "70%" }} />
                <div className="lsp-status-row__skel" style={{ width: "50%" }} />
              </>
            ) : statusesError && !allStatuses ? (
              <div className="lsp-status-row__err">
                <span>Couldn’t load languages.</span>
                <button
                  type="button"
                  className="lsp-status-row__row-act"
                  onClick={fetchStatuses}
                >
                  Retry
                </button>
              </div>
            ) : otherLanguages.length > 0 ? (
              otherLanguages.map((langEntry) => {
                const isSpin = isBusyEntry(langEntry);
                return (
                  <button
                    key={langEntry.language}
                    type="button"
                    className="lsp-status-row__row"
                    onClick={() => setSelectedLang(langEntry.language)}
                  >
                    {isSpin ? (
                      <span className="lsp-status-row__spin" aria-hidden />
                    ) : (
                      <span
                        className={`lsp-status-row__dot ${SEVERITY_DOT_CLASS[langEntry.severity]}`}
                        aria-hidden
                      />
                    )}
                    <span className="lsp-status-row__row-name">
                      {langEntry.displayName ?? langEntry.language}
                    </span>
                    <span className="lsp-status-row__row-state">{langEntry.label}</span>
                    <span className="lsp-status-row__row-go">›</span>
                  </button>
                );
              })
            ) : null}
          </div>

          {/* Not in this project (collapsed by default) */}
          {survey && notInProjectLangs.length > 0 && (
            <div
              className="lsp-status-row__sec lsp-status-row__sec--quiet"
              style={{ paddingBottom: notInProjectOpen ? 4 : 0 }}
            >
              <button
                type="button"
                className="lsp-status-row__toggle"
                onClick={() => setNotInProjectOpen((o) => !o)}
              >
                <span
                  className={`lsp-status-row__chev ${
                    notInProjectOpen ? "lsp-status-row__chev--open" : ""
                  }`}
                >
                  ▶
                </span>
                Not in this project ({notInProjectLangs.length})
              </button>
              {notInProjectOpen &&
                notInProjectLangs.map((entry) => (
                  <div
                    key={entry.language}
                    className="lsp-status-row__row lsp-status-row__row--muted"
                  >
                    <span className="lsp-status-row__row-name">{entry.displayName}</span>
                    <span className="lsp-status-row__row-state">
                      {entry.installedOnHost ? "Installed" : ""}
                    </span>
                  </div>
                ))}
            </div>
          )}

          {/* Footer: LSP settings link */}
          <div className="lsp-status-row__foot">
            <a
              href="/settings/lsp"
              onClick={(e) => {
                if (navigate) {
                  e.preventDefault();
                  navigate("/settings/lsp");
                }
              }}
            >
              LSP settings
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
