import { useEffect, useRef, useState } from "react";
import type { LspFailure, LspRemediation } from "@/lib/lspApi";
import { copyText } from "@/lib/copyText";

/** How long "Copy install command" reads "Copied" after a successful copy. */
const COPIED_MS = 1500;

/** The daemon-authored install command, if the failure offers one. */
export function installCommandOf(failure: LspFailure | null | undefined): string | null {
  return failure?.remediation.find((r) => r.kind === "copy_command")?.command ?? null;
}

interface LspRemediationActionsProps {
  failure: LspFailure;
  onRetry: () => void | Promise<void>;
  /** Each surface keeps its own button anatomy (popup / panel / outline). */
  buttonClassName: string;
  primaryClassName?: string;
}

/**
 * The remediation buttons for a latched server failure, in the daemon's
 * order. Dispatches on `remediation.kind` only — `label` is display text.
 * `view_log` is not rendered: the log route doesn't exist yet.
 */
export function LspRemediationActions({
  failure,
  onRetry,
  buttonClassName,
  primaryClassName,
}: LspRemediationActionsProps) {
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const copy = async (command: string) => {
    if (!(await copyText(command))) return;
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  const retry = async () => {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  const render = (r: LspRemediation, idx: number) => {
    switch (r.kind) {
      case "copy_command": {
        const command = r.command;
        if (!command) return null;
        return (
          <button
            key={idx}
            type="button"
            className={`${buttonClassName}${primaryClassName ? ` ${primaryClassName}` : ""}`}
            title={command}
            onClick={() => void copy(command)}
          >
            {copied ? "Copied" : r.label}
          </button>
        );
      }
      case "retry":
        return (
          <button
            key={idx}
            type="button"
            className={buttonClassName}
            disabled={retrying}
            onClick={() => void retry()}
          >
            {r.label}
          </button>
        );
      default:
        return null;
    }
  };

  return <>{failure.remediation.map(render)}</>;
}

/** The install command shown inline, readable where copy isn't available. */
export function LspInstallCommand({ failure, className }: { failure: LspFailure; className: string }) {
  const command = installCommandOf(failure);
  return command ? <code className={className}>{command}</code> : null;
}

/** Raw server text behind a disclosure — never in the main line. */
export function LspServerOutput({ failure, className }: { failure: LspFailure; className: string }) {
  if (!failure.message) return null;
  return (
    <details className={className}>
      <summary>Server output</summary>
      <pre>{failure.message}</pre>
    </details>
  );
}
