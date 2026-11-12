import { useEffect, useId, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { SupportedCli, ValidateAccountPathResponse } from "@/api/types";
import { FolderChooserDialog } from "@/components/dialogs/FolderChooserDialog";
import {
  acceptedPath,
  ghostFor,
  matchingEntries,
  sameFolder,
  chooserSeed,
} from "@/components/dialogs/folderChooserModel";
import { useCompletionKeys } from "@/components/dialogs/useCompletionKeys";
import { isAccountError } from "@/api/errors";
import { useDirSuggestions } from "@/hooks/useDirSuggestions";
import { apiErrorText } from "@/lib/apiErrorText";
import { PathGhost } from "@/components/dialogs/PathGhost";
import "./accounts.css";

const VALIDATE_DEBOUNCE_MS = 300;
const MAX_SUGGESTIONS = 6;

interface FolderFieldProps {
  api: ApiInstance;
  cli: SupportedCli;
  value: string;
  onChange: (value: string) => void;
  /** The latest validation result; null while unchecked, empty or failing. */
  onValid: (result: ValidateAccountPathResponse | null) => void;
  /** An error from the parent's own submit, shown beside the field. */
  error: string;
}

/**
 * The account folder input (plan B2a.2): label and placeholder from the CLI's
 * `accountLink`, a Browse chooser, inline completions and a debounced
 * read-only check. Nothing here names a harness; the daemon supplies the text.
 */
export function FolderField({ api, cli, value, onChange, onValid, error }: FolderFieldProps) {
  const link = cli.accountLink ?? null;
  const inputId = useId();
  const noteId = useId();
  const okId = useId();
  const errorId = useId();
  const looksOffId = useId();
  const listId = useId();
  const [focused, setFocused] = useState(false);
  const [softCheck, setSoftCheck] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [result, setResult] = useState<ValidateAccountPathResponse | null>(null);
  const [checkError, setCheckError] = useState("");
  const { suggestions, listedFor, scheduleFetch, reset, error: suggestError } = useDirSuggestions(api);
  const inputRef = useRef<HTMLInputElement>(null);
  const onValidRef = useRef(onValid);
  onValidRef.current = onValid;

  // Read-only check, debounced; a superseded request never lands.
  useEffect(() => {
    setResult(null);
    setCheckError("");
    setSoftCheck(false);
    onValidRef.current(null);
    const dir = value.trim();
    if (!dir) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      api
        .validateAccountPath({ cli: cli.id, mode: "choose", dir })
        .then((next) => {
          if (!live) return;
          setResult(next);
          onValidRef.current(next);
        })
        .catch((e: unknown) => {
          if (!live) return;
          setCheckError(apiErrorText(e, "Couldn't check this folder."));
          // An unfinished path (`~`, `~/p`) is refused with these two codes only.
          setSoftCheck(isAccountError(e, "folder_not_found") || isAccountError(e, "path_invalid"));
          onValidRef.current(null);
        });
    }, VALIDATE_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, cli.id, value]);

  const completions =
    link && listedFor !== null && sameFolder(listedFor, value)
      ? matchingEntries(suggestions, value).slice(0, MAX_SUGGESTIONS)
      : [];
  const listShown = focused && listOpen && completions.length > 0;
  // The ghost follows focus and the current value only; Escape closes the list, not the ghost.
  const ghost = focused ? ghostFor(value, completions) : null;
  // A ghost that is not fully visible is neither drawn nor accepted.
  const [ghostIsClipped, setGhostIsClipped] = useState(false);

  function typed(raw: string) {
    // A path never starts with a space; trailing spaces stay (a name may hold them).
    const next = raw.trimStart();
    onChange(next);
    keys.resetHighlight();
    setListOpen(true);
    if (next.trim()) scheduleFetch(next);
    else reset();
  }

  const keys = useCompletionKeys({
    entries: listShown ? completions : [],
    ghostEntry: ghost && !ghostIsClipped ? ghost.entry : null,
    onAccept: (entry) => typed(acceptedPath(value, entry)),
    onEnter: (active, e) => {
      if (!active) return;
      e.preventDefault();
      typed(acceptedPath(value, active));
    },
  });

  if (!link) return null;

  // A half-typed path is not an error while the input has focus.
  const shownError = checkError && softCheck && focused ? "" : checkError || error;
  const looksOff = result !== null && result.exists && !result.isEmpty && !result.looksValid;
  const showOk = !!result?.exists && !checkError;
  const optionId = (index: number) => `${listId}-opt-${index}`;
  const describedBy =
    [showOk ? okId : "", looksOff ? looksOffId : "", shownError ? errorId : "", link.fieldNote ? noteId : ""]
      .filter(Boolean)
      .join(" ") || undefined;

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape" && listShown) {
      // Close only the list; the Dialog's document listener must not see it.
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      setListOpen(false);
      return;
    }
    keys.onKeyDown(e);
  }

  return (
    <div className="accounts-folder-field">
      <label className="accounts-dialog__label" htmlFor={inputId}>
        {link.fieldLabel}
      </label>
      <div className="accounts-folder-field__row">
        <span className="path-ghost-field accounts-folder-field__ghost-wrap">
        <input
          ref={inputRef}
          id={inputId}
          className="accounts-folder-field__input"
          value={value}
          placeholder={link.exampleDir}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={shownError ? true : undefined}
          aria-describedby={describedBy}
          role="combobox"
          aria-expanded={listShown}
          aria-controls={listId}
          aria-autocomplete="both"
          aria-activedescendant={listShown && keys.activeIndex >= 0 && keys.activeIndex < completions.length ? optionId(keys.activeIndex) : undefined}
          onChange={(e) => typed(e.target.value)}
          onFocus={() => {
            setFocused(true);
            setListOpen(true);
          }}
          onBlur={() => {
            setFocused(false);
            setListOpen(false);
          }}
          onKeyDown={onKeyDown}
        />
        {ghost ? (
          <PathGhost getInput={() => inputRef.current} typed={value}
            remainder={ghost.remainder}
            onClippedChange={setGhostIsClipped}
          />
        ) : null}
        </span>
        <button type="button" className="accounts-folder-field__browse" onClick={() => setBrowsing(true)}>
          Browse…
        </button>
      </div>
      {listShown ? (
        <ul id={listId} role="listbox" className="accounts-folder-field__list" aria-label="Folder suggestions">
          {completions.map((entry, index) => (
            <li
              key={entry.path}
              id={optionId(index)}
              role="option"
              aria-selected={keys.activeIndex === index}
              className={`accounts-folder-field__option${
                keys.activeIndex === index ? " accounts-folder-field__option--active" : ""
              }`}
              // Keep focus in the input so the list stays open for the click.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => typed(acceptedPath(value, entry))}
            >
              {entry.name}/
            </li>
          ))}
        </ul>
      ) : null}
      {suggestError && value.trim() && !shownError ? (
        <p className="path-ghost-note" role="status">
          {suggestError}
        </p>
      ) : null}
      {showOk ? (
        <p id={okId} className="accounts-folder-field__ok">
          ✓ Folder exists
        </p>
      ) : null}
      {looksOff ? (
        <p id={looksOffId} className="accounts-folder-field__note">
          This does not look like a {link.fieldLabel}; sign-in will fill it.
        </p>
      ) : null}
      {shownError ? (
        <p id={errorId} className="accounts-folder-field__error" role="alert">
          {shownError}
        </p>
      ) : null}
      {link.fieldNote ? (
        <p id={noteId} className="accounts-folder-field__help">
          {link.fieldNote}
        </p>
      ) : null}
      <FolderChooserDialog
        open={browsing}
        onClose={() => setBrowsing(false)}
        onSelect={(path) => {
          setBrowsing(false);
          typed(path);
        }}
        api={api}
        initialPath={chooserSeed(value, !!result?.exists && !checkError)}
      />
    </div>
  );
}
