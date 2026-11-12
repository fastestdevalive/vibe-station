import { useEffect, useId, useState, type ReactNode } from "react";
import type { ApiInstance } from "@/api";
import { useServerStore } from "@/hooks/useServerStore";
import "./accounts.css";

interface ApiKeyStageOptions {
  api: ApiInstance;
  cliId: string;
  /** Dialog open flag: every open starts with an empty name, key and error. */
  open: boolean;
  /** Called after the account was created. */
  onAdded: () => void;
  describeError: (e: unknown, name: string) => string;
}

/**
 * The "Use an API key" stage of the add-account dialog. The key is write-only:
 * cleared the moment the request starts, only ever sent in the request body,
 * never rendered back.
 */
export function useApiKeyStage({ api, cliId, open, onAdded, describeError }: ApiKeyStageOptions): {
  panel: ReactNode;
  canSubmit: boolean;
  busy: boolean;
  submit: () => Promise<void>;
} {
  const groupId = useId();
  const keyNameId = `${groupId}-key-name`;
  const keyValueId = `${groupId}-key-value`;
  const [keyName, setKeyName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyError, setKeyError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKeyName("");
    setApiKey("");
    setKeyError("");
    setBusy(false);
  }, [open]);

  async function submit() {
    const name = keyName.trim();
    const key = apiKey;
    if (!name || !key) return;
    setApiKey("");
    setKeyError("");
    setBusy(true);
    try {
      const next = await api.createApiKeyAccount({ cli: cliId, method: "api_key", apiKey: key, label: name });
      useServerStore.getState().applyAccountUpdated(next);
      onAdded();
    } catch (e) {
      setKeyError(describeError(e, name));
    } finally {
      setBusy(false);
    }
  }

  const panel = (
    <div className="accounts-dialog__panel">
      <p className="accounts-dialog__help">
        The key is kept in a private file beside the account folder and is never shown again.
      </p>
      <label className="accounts-dialog__label" htmlFor={keyNameId}>
        Name
      </label>
      <input
        id={keyNameId}
        className="accounts-dialog__input"
        value={keyName}
        placeholder="Work or Personal"
        onChange={(e) => setKeyName(e.target.value)}
      />
      <label className="accounts-dialog__label" htmlFor={keyValueId}>
        API key
      </label>
      <input
        id={keyValueId}
        className="accounts-dialog__input"
        type="password"
        autoComplete="off"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
      {keyError ? (
        <div className="accounts-dialog__error" role="alert">
          {keyError}
        </div>
      ) : null}
    </div>
  );

  return { panel, canSubmit: !!keyName.trim() && !!apiKey, busy, submit };
}
