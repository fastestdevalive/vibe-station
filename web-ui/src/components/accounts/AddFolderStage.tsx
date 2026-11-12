import type { ApiInstance } from "@/api";
import type { SupportedCli, ValidateAccountPathResponse } from "@/api/types";
import { FolderField } from "./FolderField";

type FolderMode = "create" | "choose";

interface AddFolderStageProps {
  api: ApiInstance;
  cli: SupportedCli;
  groupId: string;
  labelId: string;
  mode: FolderMode;
  onMode: (mode: FolderMode) => void;
  label: string;
  onLabel: (label: string) => void;
  createPathLine: string;
  refusal: string;
  error: string;
  dir: string;
  onDir: (dir: string) => void;
  onChosen: (chosen: ValidateAccountPathResponse | null) => void;
  /** Null when this harness has no API-key accounts. */
  onUseApiKey: (() => void) | null;
  /** Display name of the harness, for the never-edits line. */
  cliName: string;
}

/** The "folder" stage of the Add-account dialog: pure presentation, state lives in the dialog. */
export function AddFolderStage({
  api,
  cli,
  groupId,
  labelId,
  mode,
  onMode,
  label,
  onLabel,
  createPathLine,
  refusal,
  error,
  dir,
  onDir,
  onChosen,
  onUseApiKey,
  cliName,
}: AddFolderStageProps) {
  return (
    <div className="accounts-dialog__panel">
      <fieldset className="accounts-dialog__fieldset">
        <legend className="accounts-dialog__legend">Account folder</legend>
        <label className="accounts-dialog__radio">
          <input
            type="radio"
            name={`${groupId}-mode`}
            checked={mode === "create"}
            onChange={() => onMode("create")}
          />
          Create a new folder for me
        </label>
        <label className="accounts-dialog__radio">
          <input
            type="radio"
            name={`${groupId}-mode`}
            checked={mode === "choose"}
            onChange={() => onMode("choose")}
          />
          Choose a folder
        </label>
      </fieldset>
      <div className="accounts-dialog__mode-block">
      {mode === "create" ? (
        <>
          <label className="accounts-dialog__label" htmlFor={labelId}>
            Name (optional)
          </label>
          <input
            id={labelId}
            className="accounts-dialog__input"
            value={label}
            placeholder="Work or Personal"
            onChange={(e) => onLabel(e.target.value)}
          />
          <p className="accounts-dialog__help">
            Names the new folder. Left empty, the folder takes the account id
            and the name is filled with the email after sign-in.
          </p>
          {createPathLine ? (
            <p className="accounts-dialog__help">{createPathLine}</p>
          ) : null}
          {refusal || error ? (
            <div className="accounts-dialog__error" role="alert">
              {refusal || error}
            </div>
          ) : null}
        </>
      ) : (
        <FolderField
          api={api}
          cli={cli}
          value={dir}
          onChange={onDir}
          onValid={onChosen}
          error={error}
        />
      )}
      {mode === "choose" ? (
        <p className="accounts-dialog__help">
          vibe-station runs {cliName} with this folder and never edits it. The CLI keeps its own
          files there, as it does when you run it yourself.
        </p>
      ) : null}
      </div>
      {onUseApiKey ? (
        <button
          type="button"
          className="accounts-dialog__link"
          onClick={onUseApiKey}
        >
          Use an API key instead
        </button>
      ) : null}
    </div>
  );
}
