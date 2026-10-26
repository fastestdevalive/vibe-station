import { ManualStepsBlock } from "./ManualStepsBlock";
import type { DialogCtx, DialogView } from "./dialogContext";

/** The install could not finish on its own (dmg / deb / other copies): show the manual steps. */
export function manualUpdateView({
  status,
  canInstall,
  busy,
  copiedCommand,
  onSkip,
  onClose,
  onCopyCommand,
}: DialogCtx): DialogView {
  const result = status.lastResult!;
  const isDmg = result.manual.some((s) => s.url?.endsWith(".dmg") || s.text.toLowerCase().includes(".dmg"));
  const isDeb = Boolean(
    result.debPath || result.manual.some((s) => s.kind === "command" || s.text.toLowerCase().includes(".deb")),
  );
  const dmgUrl =
    result.manual.find(
      (s) => s.kind === "open_url" && (s.url?.endsWith(".dmg") || s.text.toLowerCase().includes(".dmg")),
    )?.url ?? result.manual.find((s) => s.kind === "open_url" && !s.url?.endsWith(".sha256"))?.url;
  const debCmd =
    result.manual.find((s) => s.kind === "command")?.text ??
    (result.debPath ? `sudo apt install ${result.debPath}` : "");

  return {
    body: (
      <div className="update-dialog__body">
        <p className="update-dialog__sub">
          {isDeb ? ".deb package verified ✓" : isDmg ? "macOS app" : "Manual update required"}
        </p>
        <ManualStepsBlock
          result={result}
          targets={status.targets}
          onCopyCommand={onCopyCommand}
          copiedCommand={copiedCommand}
        />
      </div>
    ),
    footer: (
      <div className="update-dialog__footer">
        {canInstall && (
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={onSkip}>
            Skip this version
          </button>
        )}
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Close
        </button>
        {isDmg && dmgUrl && (
          <a href={dmgUrl} target="_blank" rel="noopener noreferrer" className="btn btn--primary">
            Download .dmg
          </a>
        )}
        {isDeb && debCmd && (
          <button type="button" className="btn btn--primary" onClick={() => onCopyCommand(debCmd)}>
            {copiedCommand ? "Copied" : "Copy command"}
          </button>
        )}
      </div>
    ),
  };
}
