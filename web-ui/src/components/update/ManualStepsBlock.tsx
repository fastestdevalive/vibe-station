import type { InstallResult, UpdateTarget } from "@/api/types";

/** Manual-step / updated-copies block of the Update Dialog (dmg, deb, and copies that were not updated). */
export function ManualStepsBlock({
  result,
  targets,
  onCopyCommand,
  copiedCommand,
}: {
  result: InstallResult;
  targets: UpdateTarget[];
  onCopyCommand: (cmd: string) => void;
  copiedCommand: boolean;
}) {
  const isDmg = Boolean(
    result.manual.some(
      (s) => s.url?.endsWith(".dmg") || s.text.toLowerCase().includes(".dmg"),
    ),
  );
  const isDeb = Boolean(
    result.debPath ||
    result.manual.some(
      (s) => s.url?.endsWith(".deb") || s.text.toLowerCase().includes(".deb"),
    ),
  );

  const shaStep = result.manual.find(
    (s) =>
      s.url?.endsWith(".sha256") ||
      s.text.toLowerCase().includes("checksum") ||
      s.text.toLowerCase().includes(".sha256"),
  );

  const textSteps = result.manual.filter((s) => s.kind === "text");
  const commandSteps = result.manual.filter((s) => s.kind === "command");
  // In a deb flow the command step is the `apt install` line; elsewhere it is
  // a sudo command for the copies that could not be updated automatically.
  const debCmd = isDeb
    ? (commandSteps[0]?.text ??
      (result.debPath ? `sudo apt install ${result.debPath}` : ""))
    : "";

  const updatedCopies = result.updated ?? [];
  const updatedSet = new Set(updatedCopies);
  const notUpdatedTargets = targets.filter((t) => !updatedSet.has(t.path));

  return (
    <div className="update-dialog__manual-steps">
      {isDeb && (
        <div className="update-dialog__deb-info">
          {result.debPath ? (
            <p className="update-dialog__deb-path">
              Verified package: <code>{result.debPath}</code>
            </p>
          ) : null}
          {debCmd ? (
            <div className="update-dialog__cmd-box">
              <code className="update-dialog__cmd-text">{debCmd}</code>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => onCopyCommand(debCmd)}
              >
                {copiedCommand ? "Copied" : "Copy command"}
              </button>
            </div>
          ) : null}
          {textSteps.map((step, idx) => (
            <p key={idx} className="update-dialog__step-text">
              {step.text}
            </p>
          ))}
        </div>
      )}

      {isDmg && (
        <div className="update-dialog__steps">
          <ul className="update-dialog__step-list">
            {textSteps.map((step, idx) => (
              <li key={idx}>{step.text}</li>
            ))}
          </ul>
          {shaStep?.url ? (
            <div className="update-dialog__sha-link">
              <a
                href={shaStep.url}
                target="_blank"
                rel="noopener noreferrer"
                className="update-dialog__link"
              >
                {shaStep.text}
              </a>
            </div>
          ) : null}
        </div>
      )}

      {!isDeb && !isDmg && (
        <div className="update-dialog__steps">
          <ul className="update-dialog__step-list">
            {result.manual
              .filter((step) => step.kind !== "command")
              .map((step, idx) => (
                <li key={idx}>
                  {step.url ? (
                    <a
                      href={step.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="update-dialog__link"
                    >
                      {step.text}
                    </a>
                  ) : (
                    step.text
                  )}
                </li>
              ))}
          </ul>
        </div>
      )}

      {updatedCopies.length > 0 ? (
        <div className="update-dialog__result-list">
          <span className="update-dialog__result-title">Updated:</span>
          <ul>
            {updatedCopies.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {notUpdatedTargets.length > 0 ? (
        <div className="update-dialog__result-list">
          <span className="update-dialog__result-title">
            Not updated (manual update required):
          </span>
          <ul>
            {notUpdatedTargets.map((t) => (
              <li key={`${t.method}:${t.path}`}>
                {t.path} ({t.method})
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!isDeb &&
        commandSteps.map((step, idx) => (
          <div key={`cmd-${idx}`} className="update-dialog__steps">
            <p className="update-dialog__step-text">Run this to update them:</p>
            <div className="update-dialog__cmd-box">
              <code className="update-dialog__cmd-text">{step.text}</code>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => onCopyCommand(step.text)}
              >
                {copiedCommand ? "Copied" : "Copy command"}
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}
