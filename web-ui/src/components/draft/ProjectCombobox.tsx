import { useCallback, useEffect, useMemo, useRef, useState, Fragment, useId } from "react";
import { ChevronDown, Plus, Search } from "lucide-react";
import { useEventTargets } from "@/context/DemoEnv";
import type { ApiInstance } from "@/api";
import type { Project, Settings } from "@/api/types";
import { Input } from "../ui/Input";
import { FolderChooserDialog } from "../dialogs/FolderChooserDialog";
import { useDirSuggestions } from "@/hooks/useDirSuggestions";
import { DraftFieldRow } from "./DraftFieldRow";
import {
  isAbsoluteQuery,
  expandHome,
  normalizePath,
  matchesQuery,
  validateProjectName,
  type Mode_,
  type ProjectRow,
} from "./draftComposerHelpers";

interface ProjectComboboxProps {
  api: ApiInstance;
  projects: Project[];
  settings: Settings | null;
  onSelectExisting: (p: Project) => void;
  onNewName: (name: string, parentDir: string) => void;
  onAddPath: (path: string) => void;
  onClear?: () => void;
}

export function ProjectCombobox({
  api,
  projects,
  settings,
  onSelectExisting,
  onNewName,
  onAddPath,
  onClear,
}: ProjectComboboxProps) {
  const { doc } = useEventTargets();
  const projectFieldId = useId();
  const projectListboxId = useId();
  const dirFieldId = useId();
  const dirListboxId = useId();

  // ── Project combobox state ──────────────────────────────────────────────
  const [mode, setMode] = useState<Mode_>("search");
  const [query, setQuery] = useState("");
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [popupOpen, setPopupOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const projectWrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pathSuggs = useDirSuggestions(api);
  const [dirChooserOpen, setDirChooserOpen] = useState(false);

  // ── Directory combobox state (create mode only) ─────────────────────────
  const [parentDir, setParentDir] = useState("");
  const [defaultProjectsDir, setDefaultProjectsDir] = useState("");
  const [homeDir, setHomeDir] = useState("");
  const parentDirSuggs = useDirSuggestions(api);
  const [dirPopupOpen, setDirPopupOpen] = useState(false);
  const [dirActiveIndex, setDirActiveIndex] = useState(0);
  const dirWrapperRef = useRef<HTMLDivElement>(null);

  // ── Git status check state ──────────────────────────────────────────────
  const [isGitFolder, setIsGitFolder] = useState<boolean | null>(null);
  // Only meaningful when isGitFolder === true. project-setup.sh makes an
  // initial commit of the whole directory when HEAD doesn't resolve, so the
  // hint copy needs this to describe accurately what submitting will do.
  const [hasCommits, setHasCommits] = useState<boolean | null>(null);
  const [checkingGit, setCheckingGit] = useState(false);
  const checkGitReqIdRef = useRef(0);
  const checkGitDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load default dirs from settings when they resolve.
  useEffect(() => {
    if (settings) {
      setDefaultProjectsDir(settings.defaultProjectsDir);
      if (settings.homeDir) setHomeDir(settings.homeDir);
    }
  }, [settings]);

  // R7: seed parentDir from defaultProjectsDir once it resolves (async), as
  // long as the user hasn't already typed something into Directory.
  useEffect(() => {
    if (defaultProjectsDir && !parentDir) {
      // Show the real configured path (e.g. /home/vst/projects) rather than a
      // `~`-collapsed form — it matches what Settings displays. Typed `~/…`
      // paths are still expanded on submit.
      setParentDir(defaultProjectsDir);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultProjectsDir, homeDir]);

  // Re-seed on entering create mode too (covers the race where settings
  // hadn't resolved yet when the user committed the create-new row), and
  // kick off a directory listing for whatever parentDir is set.
  useEffect(() => {
    if (mode !== "create") return;
    if (!parentDir && defaultProjectsDir) {
      setParentDir(defaultProjectsDir);
      return;
    }
    if (parentDir) parentDirSuggs.scheduleFetch(parentDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ── Outside-click closes each popup ──────────────────────────────────────
  useEffect(() => {
    if (!popupOpen) return;
    function onDocMouseDown(e: MouseEvent) {
      if (projectWrapperRef.current && !projectWrapperRef.current.contains(e.target as Node)) {
        setPopupOpen(false);
      }
    }
    doc.addEventListener("mousedown", onDocMouseDown);
    return () => doc.removeEventListener("mousedown", onDocMouseDown);
  }, [popupOpen, doc]);

  useEffect(() => {
    if (!dirPopupOpen) return;
    function onDocMouseDown(e: MouseEvent) {
      if (dirWrapperRef.current && !dirWrapperRef.current.contains(e.target as Node)) {
        setDirPopupOpen(false);
      }
    }
    doc.addEventListener("mousedown", onDocMouseDown);
    return () => doc.removeEventListener("mousedown", onDocMouseDown);
  }, [dirPopupOpen, doc]);

  // Cleanup the debounce timer on unmount.
  useEffect(() => {
    return () => {
      if (checkGitDebounceRef.current) clearTimeout(checkGitDebounceRef.current);
    };
  }, []);

  // ── Project combobox rows ────────────────────────────────────────────────
  const trimmedQuery = query.trim();
  /**
   * Resolve a path to the project already registered at it, if any. The single
   * source of truth for that question — the add-path row, the auto-adopt effect
   * and `adoptPath` all go through here so they can never disagree about
   * whether a directory is "new".
   */
  const findRegisteredProject = useCallback(
    (path: string): Project | null => {
      const norm = normalizePath(path, homeDir);
      if (!norm) return null;
      return projects.find((p) => p.path === norm) ?? null;
    },
    [projects, homeDir],
  );
  const alreadyRegistered = useMemo(
    () => findRegisteredProject(trimmedQuery) !== null,
    [findRegisteredProject, trimmedQuery],
  );
  const showAddPathRow = isAbsoluteQuery(trimmedQuery) && !alreadyRegistered;
  // Suppress the leading create/add-path row when the typed query is an absolute
  // path that's already a registered project — that project shows in the list
  // instead (matchesQuery matches on path), avoiding a dead-end "create" row.
  const showLeadingRow = !(isAbsoluteQuery(trimmedQuery) && alreadyRegistered);

  // Debounced check for whether the typed path is already a Git repository
  // (and whether it has any commits). Keyed on `showAddPathRow && trimmedQuery`
  // rather than "mode === add-path && query changes" — once mode is add-path,
  // any edit snaps it back to "search" (R5 in handleQueryChange), so the query
  // can never change while add-path mode is active and that trigger would be
  // dead code. Firing while the row is merely offered means the subtitle can
  // reflect git status too, but it now runs on every keystroke, hence the
  // debounce + request-id guard below (mirrors fetchDirSuggestions).
  useEffect(() => {
    if (!showAddPathRow || !trimmedQuery) {
      setIsGitFolder(null);
      setHasCommits(null);
      setCheckingGit(false);
      return;
    }

    let cancelled = false;
    const reqId = ++checkGitReqIdRef.current;

    if (checkGitDebounceRef.current) clearTimeout(checkGitDebounceRef.current);
    checkGitDebounceRef.current = setTimeout(async () => {
      setCheckingGit(true);
      try {
        const expanded = expandHome(trimmedQuery, homeDir);
        const res = await api.checkFsPath(expanded);
        if (reqId !== checkGitReqIdRef.current || cancelled) return;
        if (res.exists && res.isDirectory) {
          setIsGitFolder(res.isGit);
          setHasCommits(res.isGit ? res.hasCommits : null);
        } else {
          setIsGitFolder(null);
          setHasCommits(null);
        }
      } catch {
        if (reqId !== checkGitReqIdRef.current || cancelled) return;
        setIsGitFolder(null);
        setHasCommits(null);
      } finally {
        if (reqId === checkGitReqIdRef.current && !cancelled) {
          setCheckingGit(false);
        }
      }
    }, 250); // ≥250ms — /fs/check shells out to git; avoid a spawn per keystroke

    return () => {
      cancelled = true;
      if (checkGitDebounceRef.current) clearTimeout(checkGitDebounceRef.current);
    };
  }, [showAddPathRow, trimmedQuery, homeDir, api]);

  const filteredProjects = useMemo(
    () => projects.filter((p) => matchesQuery(p, trimmedQuery)),
    [projects, trimmedQuery],
  );
  const rows: ProjectRow[] = useMemo(() => {
    // Per the approved mockup (State B2), the add-existing-directory row
    // REPLACES the create-new row rather than sitting alongside it — a
    // slash-containing query can't be a valid project name anyway.
    const list: ProjectRow[] = [];
    if (showLeadingRow) {
      if (showAddPathRow) {
        list.push({ kind: "add-path" });
        for (const entry of pathSuggs.suggestions) {
          list.push({ kind: "path-suggestion", entry });
        }
      } else {
        list.push({ kind: "create" });
      }
    }
    for (const p of filteredProjects) list.push({ kind: "existing", project: p });
    return list;
  }, [showLeadingRow, showAddPathRow, pathSuggs.suggestions, filteredProjects]);

  useEffect(() => {
    setActiveIndex((i) => Math.min(i, rows.length - 1));
  }, [rows.length]);

  /**
   * Commit to a directory, whatever route the user took to pick it (the
   * add-existing row, the Browse chooser, or a stale add-path mode). The choice
   * of flow is derived from the path itself, never from which control was
   * clicked: a directory that is already a registered project adopts that
   * project — chip, real project name, its branch list — instead of offering to
   * register it a second time (which the daemon would 409 anyway).
   */
  function adoptPath(rawPath: string) {
    setPopupOpen(false);
    setActiveIndex(0);

    const existing = findRegisteredProject(rawPath);
    if (existing) {
      setMode("existing");
      setSelectedProject(existing);
      onSelectExisting(existing);
      return;
    }

    setMode("add-path");
    setSelectedProject(null);
    const trimmed = rawPath.trim();
    // Drop a trailing separator so the value matches what gets registered, but
    // never blank out a bare "/".
    setQuery(trimmed.replace(/\/+$/, "") || trimmed);
    onAddPath(trimmed.replace(/\/+$/, "") || trimmed);
  }

  /**
   * Safety net for the same rule: if we're sitting in add-path mode for a path
   * that turns out to be a registered project, correct to existing mode. This
   * catches the race where `listProjects()` hadn't resolved yet when the user
   * clicked "Add existing directory" — without it, submitting 409s with
   * "already registered" and dead-ends the dialog.
   */
  useEffect(() => {
    if (mode !== "add-path") return;
    const existing = findRegisteredProject(trimmedQuery);
    if (!existing) return;
    setMode("existing");
    setSelectedProject(existing);
    setQuery(existing.path);
    onSelectExisting(existing);
  }, [mode, trimmedQuery, findRegisteredProject, onSelectExisting]);

  function selectProjectRow(row: ProjectRow) {
    if (row.kind === "path-suggestion") {
      const pathWithTrailingSep = row.entry.path.endsWith("/") ? row.entry.path : row.entry.path + "/";
      setQuery(pathWithTrailingSep);
      pathSuggs.fetchSuggestions(pathWithTrailingSep);
      setActiveIndex(0);
      return;
    }

    if (row.kind === "create") {
      setMode("create");
      setQuery(trimmedQuery);
      onNewName(trimmedQuery, parentDir);
    } else if (row.kind === "add-path") {
      // Routed through adoptPath so the path decides the flow, not the row.
      adoptPath(trimmedQuery);
      return;
    } else {
      setMode("existing");
      setSelectedProject(row.project);
      onSelectExisting(row.project);
    }
    setPopupOpen(false);
  }

  function handleQueryChange(value: string) {
    setQuery(value);
    // R5: editing while in create/add-path mode returns to search + reopens popup.
    if (mode !== "search") setMode("search");
    setPopupOpen(true);
    setActiveIndex(0);
    const trimmed = value.trim();
    if (isAbsoluteQuery(trimmed)) {
      pathSuggs.scheduleFetch(trimmed);
    } else {
      pathSuggs.reset();
    }
  }

  function clearSelection() {
    setSelectedProject(null);
    setQuery("");
    setMode("search");
    onClear?.();
  }

  function handleProjectKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!popupOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        setPopupOpen(true);
        e.preventDefault();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, rows.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        e.nativeEvent.stopImmediatePropagation();
        if (rows[activeIndex]) selectProjectRow(rows[activeIndex]);
        break;
      case "Escape":
        e.preventDefault();
        e.nativeEvent.stopImmediatePropagation();
        setPopupOpen(false);
        triggerRef.current?.focus();
        break;
      default:
        break;
    }
  }

  // ── Directory combobox ───────────────────────────────────────────────────
  function handleParentDirChange(value: string) {
    setParentDir(value);
    setDirPopupOpen(true);
    if (value.trim()) {
      parentDirSuggs.scheduleFetch(value);
    } else {
      parentDirSuggs.reset();
    }
  }

  function selectDirEntry(path: string) {
    setParentDir(path);
    setDirPopupOpen(false);
    parentDirSuggs.scheduleFetch(path);
  }

  function handleDirKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const suggestions = parentDirSuggs.suggestions;
    if (!dirPopupOpen || suggestions.length === 0) {
      if (e.key === "ArrowDown" && suggestions.length > 0) {
        setDirPopupOpen(true);
        e.preventDefault();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setDirActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setDirActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter": {
        e.preventDefault();
        e.nativeEvent.stopImmediatePropagation();
        const entry = suggestions[dirActiveIndex];
        if (entry) selectDirEntry(entry.path);
        break;
      }
      case "Escape":
        e.preventDefault();
        e.nativeEvent.stopImmediatePropagation();
        setDirPopupOpen(false);
        break;
      default:
        break;
    }
  }

  // ── Derived preview / worktree copy ──────────────────────────────────────
  const dirDisplay = parentDir || defaultProjectsDir || "~/projects";
  const willCreatePath = trimmedQuery ? `${dirDisplay}/${trimmedQuery}` : "";

  // Create-new gating: keep the rest of the form hidden until the typed project
  // name is valid (≥3 chars, no separators/traversal, not just spaces).
  const createNameValid = validateProjectName(trimmedQuery) === null;

  const activeDescendant = popupOpen && rows[activeIndex] ? `${projectListboxId}-${activeIndex}` : undefined;
  const dirActiveDescendant = dirPopupOpen && parentDirSuggs.suggestions[dirActiveIndex]
    ? `${dirListboxId}-${dirActiveIndex}`
    : undefined;

  // Copy for the "Add existing directory" row's subtitle and the form hint
  // below the input. Must match what submitAddPath's setup:true actually runs
  // (project-setup.sh — see daemon/src/assets/project-setup.sh): it inits git
  // + writes a .gitignore (only if absent) when the dir isn't a repo, but ALSO
  // makes an initial commit of the whole directory whenever HEAD doesn't
  // resolve — including for an already-git dir that just has no commits yet.
  const addPathGitCopy = (() => {
    if (checkingGit) {
      return { subtitle: "Checking directory git status…", hint: "Checking directory git status…" };
    }
    if (isGitFolder === true) {
      if (hasCommits === false) {
        return {
          subtitle: "Git repository detected (no commits yet)",
          hint:
            "ⓘ Registers this directory as a project. It’s already a git repository with no commits " +
            "yet, so an initial commit of its current contents will be made.",
        };
      }
      return {
        subtitle: "Git repository detected",
        hint: "ⓘ Registers this directory as a project (git repository detected).",
      };
    }
    if (isGitFolder === false) {
      return {
        subtitle: "Not yet a vibe-station project (will initialize git)",
        hint:
          "ⓘ Registers this directory, runs git init, adds a .gitignore, and makes an initial " +
          "commit of the directory's current contents.",
      };
    }
    // null — not yet checked, or the check failed. Generic fallback copy.
    return {
      subtitle: "not yet a vibe-station project",
      hint: "ⓘ Registers this directory and sets up git (init + .gitignore) if not already present.",
    };
  })();

  return (
    <>
      {/* Project combobox */}
      {mode === "search" ? (
        <div className="combobox-wrapper" ref={projectWrapperRef}>
          <DraftFieldRow label="Project">
            <span className="draft-tag draft-tag--required">required</span>
            <button
              type="button"
              ref={triggerRef}
              className="draft-row__trigger"
              aria-haspopup="listbox"
              aria-expanded={popupOpen}
              aria-controls={projectListboxId}
              onClick={() => setPopupOpen((o) => !o)}
            >
              <span className="draft-row__trigger-label">Choose a project</span>
              <ChevronDown
                size={14}
                aria-hidden
                className={popupOpen ? "draft-row__chev--open" : undefined}
              />
            </button>
          </DraftFieldRow>

          {popupOpen ? (
            <div className="draft-popover draft-popover--down">
              <button type="button" className="draft-popover__item" onClick={() => setDirChooserOpen(true)}>
                <span aria-hidden>＋</span>
                <span className="draft-popover__text">
                  <span>Add existing folder…</span>
                  <span className="draft-popover__sub">browse the server</span>
                </span>
              </button>
              <div className="draft-popover__search">
                <Search size={13} aria-hidden />
                <Input
                  id={projectFieldId}
                  type="text"
                  role="combobox"
                  aria-expanded={popupOpen}
                  aria-controls={projectListboxId}
                  aria-activedescendant={activeDescendant}
                  autoComplete="off"
                  placeholder="Search projects or type a new name…"
                  value={query}
                  onChange={(e) => handleQueryChange(e.target.value)}
                  onKeyDown={handleProjectKeyDown}
                  autoFocus
                  style={{ width: "100%", height: 26, padding: "0 4px", border: "none", background: "transparent", fontSize: "var(--font-size-sm)" }}
                />
              </div>
              <div className="draft-popover__list" role="listbox" id={projectListboxId}>
                {rows.map((row, idx) => {
                  const prevRow = rows[idx - 1];
                  const showSuggestionsHeader = row.kind === "path-suggestion" && prevRow?.kind !== "path-suggestion";
                  const showExistingHeader = row.kind === "existing" && prevRow?.kind !== "existing";
                  const key = row.kind === "existing"
                    ? row.project.id
                    : row.kind === "path-suggestion"
                      ? `suggest-${row.entry.path}`
                      : row.kind;
                  const pinned =
                    row.kind === "create" || row.kind === "add-path"
                      ? " draft-popover__pinned-option"
                      : "";

                  return (
                    <Fragment key={key}>
                      {showSuggestionsHeader && (
                        <div className="combobox-popup__group-label" role="presentation">
                          SUGGESTED DIRECTORIES
                        </div>
                      )}
                      {showExistingHeader && (
                        <div className="combobox-popup__group-label" role="presentation">
                          USE EXISTING{trimmedQuery ? ` (${filteredProjects.length})` : ""}
                        </div>
                      )}

                      {row.kind === "add-path" && (
                        <button
                          type="button"
                          role="option"
                          tabIndex={-1}
                          id={`${projectListboxId}-${idx}`}
                          aria-selected={activeIndex === idx}
                          className={`combobox-option${activeIndex === idx ? " combobox-option--active" : ""}${pinned}`}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            selectProjectRow(row);
                          }}
                          onMouseEnter={() => setActiveIndex(idx)}
                        >
                          <span className="combobox-option__title">
                            <span aria-hidden>＋</span>
                            {`Add existing directory "${trimmedQuery}"`}
                          </span>
                          <span className="combobox-option__subtitle">
                            {addPathGitCopy.subtitle}
                          </span>
                        </button>
                      )}

                      {row.kind === "create" && (
                        <button
                          type="button"
                          role="option"
                          tabIndex={-1}
                          id={`${projectListboxId}-${idx}`}
                          aria-selected={activeIndex === idx}
                          className={`combobox-option${activeIndex === idx ? " combobox-option--active" : ""}${pinned}`}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            selectProjectRow(row);
                          }}
                          onMouseEnter={() => setActiveIndex(idx)}
                        >
                          <span className="combobox-option__title">
                            <span aria-hidden>✦</span>
                            {trimmedQuery ? `Create new project "${trimmedQuery}"` : "Create new project"}
                          </span>
                          <span className="combobox-option__subtitle">
                            {trimmedQuery
                              ? `Creates ${dirDisplay}/${trimmedQuery}`
                              : "Start typing a name…"}
                          </span>
                        </button>
                      )}

                      {row.kind === "path-suggestion" && (
                        <button
                          type="button"
                          role="option"
                          tabIndex={-1}
                          id={`${projectListboxId}-${idx}`}
                          aria-selected={activeIndex === idx}
                          className={`combobox-option${activeIndex === idx ? " combobox-option--active" : ""}`}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            selectProjectRow(row);
                          }}
                          onMouseEnter={() => setActiveIndex(idx)}
                        >
                          <span className="combobox-option__title">
                            <span aria-hidden>📁</span>
                            {row.entry.path}
                          </span>
                        </button>
                      )}

                      {row.kind === "existing" && (
                        <button
                          type="button"
                          role="option"
                          tabIndex={-1}
                          id={`${projectListboxId}-${idx}`}
                          aria-selected={activeIndex === idx}
                          className={`combobox-option${activeIndex === idx ? " combobox-option--active" : ""}`}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            selectProjectRow(row);
                          }}
                          onMouseEnter={() => setActiveIndex(idx)}
                        >
                          <span className="combobox-option__title">
                            <span aria-hidden>▸</span>
                            {row.project.name}
                          </span>
                          <span className="combobox-option__subtitle">{row.project.path}</span>
                        </button>
                      )}
                    </Fragment>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : mode === "existing" && selectedProject ? (
        <DraftFieldRow
          label="Project"
          message={
            <>
              <span className="draft-dot draft-dot--ok" />
              Using existing project at {selectedProject.path}
            </>
          }
        >
          <span aria-hidden>◧</span>
          <span className="draft-row__project-name">{selectedProject.name}</span>
          <button
            type="button"
            className="draft-row__icon-btn"
            aria-label="Clear selected project"
            onClick={clearSelection}
          >
            ✕
          </button>
        </DraftFieldRow>
      ) : mode === "add-path" ? (
        <DraftFieldRow
          label="Project"
          message={
            <>
              <span className={isGitFolder === false ? "draft-dot draft-dot--warn" : "draft-dot draft-dot--idle"} />
              {addPathGitCopy.hint}
            </>
          }
        >
          <span className="draft-row__path">{query}</span>
          {isGitFolder === true ? (
            <span className="draft-tag">git</span>
          ) : isGitFolder === false ? (
            <span className="draft-tag">no git</span>
          ) : null}
          <button
            type="button"
            className="draft-row__link"
            onClick={() => {
              setMode("search");
              setQuery("");
              setPopupOpen(true);
              onClear?.();
            }}
          >
            Change
          </button>
        </DraftFieldRow>
      ) : mode === "create" ? (
        <>
          <DraftFieldRow
            label="Project"
            message={!createNameValid ? <div className="field-error">{validateProjectName(trimmedQuery)}</div> : undefined}
          >
            <Plus size={14} aria-hidden />
            <span>New project</span>
            <button
              type="button"
              className="draft-row__link"
              onClick={() => {
                setMode("search");
                setQuery(trimmedQuery);
                setPopupOpen(true);
                onClear?.();
              }}
            >
              Change
            </button>
          </DraftFieldRow>
          <DraftFieldRow label="Name">
            <span className="draft-row__readonly">{trimmedQuery}</span>
          </DraftFieldRow>
          {createNameValid ? (
            <>
              <DraftFieldRow label="Parent folder">
                <div className="draft-popover-anchor" style={{ width: "100%" }}>
                  <div className="combobox-wrapper" ref={dirWrapperRef} style={{ width: "100%" }}>
                    <Input
                      id={dirFieldId}
                      type="text"
                      role="combobox"
                      aria-expanded={dirPopupOpen}
                      aria-controls={dirListboxId}
                      aria-activedescendant={dirActiveDescendant}
                      autoComplete="off"
                      placeholder={defaultProjectsDir || "~/projects"}
                      value={parentDir}
                      onChange={(e) => handleParentDirChange(e.target.value)}
                      onFocus={() => {
                        if (parentDirSuggs.suggestions.length > 0) setDirPopupOpen(true);
                      }}
                      onKeyDown={handleDirKeyDown}
                      style={{ width: 260, maxWidth: "100%", height: 26, padding: "0 8px", fontSize: "var(--font-size-sm)" }}
                    />
                    {dirPopupOpen && parentDirSuggs.suggestions.length > 0 ? (
                      <div className="draft-popover draft-popover--down" role="listbox" id={dirListboxId}>
                        {parentDirSuggs.suggestions.map((entry, i) => (
                          <button
                            key={entry.path}
                            type="button"
                            role="option"
                            tabIndex={-1}
                            id={`${dirListboxId}-${i}`}
                            aria-selected={dirActiveIndex === i}
                            className={`combobox-option${dirActiveIndex === i ? " combobox-option--active" : ""}`}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              selectDirEntry(entry.path);
                            }}
                            onMouseEnter={() => setDirActiveIndex(i)}
                          >
                            <span className="combobox-option__title">{entry.path}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </DraftFieldRow>
              <div className="draft-row__msg draft-row__note">
                Will create <code className="new-agent__will-create-path">{willCreatePath}</code>
                <div>ⓘ Sets up git (init + .gitignore) if not already present.</div>
              </div>
            </>
          ) : null}
        </>
      ) : null}

      <FolderChooserDialog
        open={dirChooserOpen}
        onClose={() => setDirChooserOpen(false)}
        // "Select Folder" is an explicit commit, so resolve it the same way the
        // add-existing row does: adopt the registered project if there is one,
        // otherwise drop into add-path with the git-aware hint.
        onSelect={(path) => adoptPath(path)}
        api={api}
        initialPath={query || defaultProjectsDir || "/"}
      />
    </>
  );
}
