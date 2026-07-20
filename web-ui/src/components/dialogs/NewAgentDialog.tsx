import { useEffect, useMemo, useRef, useState, useId } from "react";
import { useNavigate } from "react-router-dom";
import type { ApiInstance } from "@/api";
import type { CreateProjectBody, Mode, Project, Settings, SupportedCli } from "@/api/types";
import { ApiError } from "@/api/errors";
import { Dialog } from "./Dialog";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { AttachmentPicker } from "../chat/AttachmentPicker";
import { sendJsonFirstTurn } from "@/api/firstTurn";

interface NewAgentDialogProps {
  open: boolean;
  onClose: () => void;
  api: ApiInstance;
  onCreated?: (project: Project) => void;
}

/** How the "Project" combobox has been resolved. */
type Mode_ = "search" | "create" | "add-path" | "existing";

type ProjectRow =
  | { kind: "create" }
  | { kind: "add-path" }
  | { kind: "existing"; project: Project };

const DIR_DEBOUNCE_MS = 150;

function isAbsoluteQuery(q: string): boolean {
  return q.startsWith("/") || q === "~" || q.startsWith("~/");
}

/** Expand a leading `~` to the real home dir (for API calls / comparisons). */
function expandHome(p: string, home: string): string {
  if (!home) return p;
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1);
  return p;
}

function matchesQuery(p: Project, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    p.name.toLowerCase().includes(needle) ||
    p.id.toLowerCase().includes(needle) ||
    // Match on path too, so typing an already-registered project's absolute
    // path surfaces it in the list instead of a dead-end "create" row.
    p.path.toLowerCase().includes(needle)
  );
}

/**
 * Inline project-name validation for the create-new flow. Covers the daemon's
 * rules (separators / `..` / leading dot) plus a deliberately stricter minimum
 * length — the daemon accepts min 1, but a brand-new project wants a real name,
 * so we require ≥3 chars here.
 */
function validateProjectName(trimmed: string): string | null {
  if (!trimmed) return "Project name is required.";
  if (trimmed.length < 3) return "Project name must be at least 3 characters.";
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return "Project name cannot contain path separators (/ or \\).";
  }
  if (trimmed.includes("..")) {
    return "Project name cannot contain '..' (path traversal).";
  }
  if (trimmed.startsWith(".")) {
    return "Project name cannot start with a dot.";
  }
  return null;
}

/**
 * Mirrors daemon `branchValidator.ts` rules for fast inline feedback. When the
 * effective base branch is known (create → always "main"; existing → the
 * selected base), a new branch equal to it is rejected as a collision. In
 * add-path mode the base isn't known until the server responds, so `baseBranch`
 * is omitted and the daemon does the collision check.
 */
function validateBranchName(trimmed: string, baseBranch?: string): string | null {
  if (!trimmed) return "Branch name is required.";
  if (trimmed.length > 200) return "Branch name exceeds 200 character limit.";
  if (trimmed.includes("..")) return 'Branch name cannot contain ".."';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(trimmed)) {
    return "Branch name must start with an alphanumeric character and contain only [a-zA-Z0-9._/-]";
  }
  if (baseBranch && trimmed === baseBranch) {
    return `Branch cannot be '${baseBranch}' — it collides with the base branch.`;
  }
  return null;
}

/**
 * Suggest a worktree branch name that doesn't collide with an existing branch.
 * `git worktree add -b <b>` fails if `<b>` already exists, so defaulting every
 * new worktree to a bare "feature" guarantees a failure on the second one.
 */
function uniqueBranchName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!existing.includes(candidate)) return candidate;
  }
  return base;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function NewAgentDialog({
  open,
  onClose,
  api,
  onCreated,
}: NewAgentDialogProps) {
  const navigate = useNavigate();
  const projectFieldId = useId();
  const projectListboxId = useId();
  const dirFieldId = useId();
  const dirListboxId = useId();

  // ── Project combobox state ──────────────────────────────────────────────
  const [mode, setMode] = useState<Mode_>("search");
  const [query, setQuery] = useState("");
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [popupOpen, setPopupOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const projectWrapperRef = useRef<HTMLDivElement>(null);

  // ── Directory combobox state (create mode only) ─────────────────────────
  const [parentDir, setParentDir] = useState("");
  const [defaultProjectsDir, setDefaultProjectsDir] = useState("");
  const [homeDir, setHomeDir] = useState("");
  const [dirEntries, setDirEntries] = useState<{ name: string; path: string }[]>([]);
  const [dirPopupOpen, setDirPopupOpen] = useState(false);
  const [dirActiveIndex, setDirActiveIndex] = useState(0);
  const dirWrapperRef = useRef<HTMLDivElement>(null);
  const dirReqIdRef = useRef(0);
  const dirDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Agent section — always visible once a project source is chosen ─────
  const [useWorktree, setUseWorktree] = useState(false);
  const [branch, setBranch] = useState("feature");
  // Base branch for the "use existing (git)" case — populated from
  // GET /projects/:id/branches, or free-typed if that fetch fails.
  const [baseBranch, setBaseBranch] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [channel, setChannel] = useState<"terminal" | "json">("terminal");
  const [files, setFiles] = useState<File[]>([]);
  const [modes, setModes] = useState<Mode[]>([]);
  const [modeId, setModeId] = useState("");
  const [clis, setClis] = useState<SupportedCli[]>([]);

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Load modes + projects + settings when dialog opens.
  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const ms = await api.listModes();
        setModes(ms);
        if (ms[0]) setModeId(ms[0].id);
      } catch {
        // Modes not available — submit stays disabled (no modeId).
      }

      try {
        setClis(await api.getSupportedClis());
      } catch {
        // Capabilities not available — JSON stays enabled (daemon still gates).
      }

      try {
        const ps = await api.listProjects();
        setProjects(ps);
      } catch {
        // Projects not available — combobox just shows create-new.
      }

      try {
        const settings: Settings = await api.getSettings();
        setDefaultProjectsDir(settings.defaultProjectsDir);
        if (settings.homeDir) setHomeDir(settings.homeDir);
      } catch {
        // Settings not available.
      }
    })();
  }, [open, api]);

  // JSON channel is only offered for CLIs whose plugin supportsJson (daemon
  // gates this too). Default to allowed until capabilities load.
  const selectedCli = modes.find((m) => m.id === modeId)?.cli;
  const jsonSupported =
    selectedCli == null || clis.length === 0
      ? true
      : (clis.find((c) => c.id === selectedCli)?.supportsJson ?? true);

  // If the selected mode's CLI can't run JSON, snap back to terminal.
  useEffect(() => {
    if (!jsonSupported && channel === "json") setChannel("terminal");
  }, [jsonSupported, channel]);

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
    if (parentDir) scheduleDirFetch(parentDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Fetch branches for the "use existing (git)" case. A fetch failure falls
  // back to a free-text base-branch input (mirrors NewSessionDialog).
  useEffect(() => {
    if (mode !== "existing" || !selectedProject || !selectedProject.isGit) {
      setBranches([]);
      setBranchesError(null);
      setBranchesLoading(false);
      return;
    }
    let cancelled = false;
    setBranchesLoading(true);
    setBranchesError(null);
    void (async () => {
      try {
        const res = await api.listProjectBranches(selectedProject.id);
        if (cancelled) return;
        setBranches(res.branches);
        // defaultBranch can be null (non-git); this effect only runs for git
        // projects, but guard anyway and fall back to the first branch.
        const preferred = res.defaultBranch ?? "";
        const def =
          preferred && res.branches.includes(preferred)
            ? preferred
            : (res.branches[0] ?? preferred);
        setBaseBranch(def);
        // Bump the default worktree branch off a collision (feature → feature-2)
        // — but only if the user hasn't already typed a custom one.
        setBranch((prev) => (prev === "feature" ? uniqueBranchName("feature", res.branches) : prev));
      } catch (err) {
        if (cancelled) return;
        setBranches([]);
        // Detail is logged (not surfaced) — the UI shows a concise fallback and
        // lets the user type a base branch. `branchesError` gates that message.
        console.warn("Failed to load project branches:", err);
        setBranchesError(
          err instanceof ApiError
            ? err.message || `Could not load branches (HTTP ${err.status})`
            : err instanceof Error
              ? err.message
              : String(err),
        );
      } finally {
        if (!cancelled) setBranchesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, selectedProject, api]);

  function reset() {
    setMode("search");
    setQuery("");
    setSelectedProject(null);
    setPopupOpen(false);
    setActiveIndex(0);
    setParentDir("");
    setDirEntries([]);
    setDirPopupOpen(false);
    setDirActiveIndex(0);
    setUseWorktree(false);
    setBranch("feature");
    setBaseBranch("");
    setBranches([]);
    setBranchesError(null);
    setPrompt("");
    setChannel("terminal");
    setFiles([]);
    setError(null);
    setSubmitting(false);
  }

  function handleClose() {
    reset();
    onClose();
  }

  // ── Outside-click closes each popup ──────────────────────────────────────
  useEffect(() => {
    if (!popupOpen) return;
    function onDocMouseDown(e: MouseEvent) {
      if (projectWrapperRef.current && !projectWrapperRef.current.contains(e.target as Node)) {
        setPopupOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [popupOpen]);

  useEffect(() => {
    if (!dirPopupOpen) return;
    function onDocMouseDown(e: MouseEvent) {
      if (dirWrapperRef.current && !dirWrapperRef.current.contains(e.target as Node)) {
        setDirPopupOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [dirPopupOpen]);

  // Cleanup the debounce timer on unmount.
  useEffect(() => {
    return () => {
      if (dirDebounceRef.current) clearTimeout(dirDebounceRef.current);
    };
  }, []);

  // ── Project combobox rows ────────────────────────────────────────────────
  const trimmedQuery = query.trim();
  const alreadyRegistered = useMemo(() => {
    // Expand `~` and strip a trailing slash so `~/foo`, `/home/me/foo` and
    // `/home/me/foo/` all match an already-registered project's absolute path.
    const expanded = expandHome(trimmedQuery, homeDir).replace(/\/+$/, "");
    return projects.some((p) => p.path === expanded);
  }, [projects, trimmedQuery, homeDir]);
  const showAddPathRow = isAbsoluteQuery(trimmedQuery) && !alreadyRegistered;
  // Suppress the leading create/add-path row when the typed query is an absolute
  // path that's already a registered project — that project shows in the list
  // instead (matchesQuery matches on path), avoiding a dead-end "create" row.
  const showLeadingRow = !(isAbsoluteQuery(trimmedQuery) && alreadyRegistered);
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
      list.push(showAddPathRow ? { kind: "add-path" } : { kind: "create" });
    }
    for (const p of filteredProjects) list.push({ kind: "existing", project: p });
    return list;
  }, [showLeadingRow, showAddPathRow, filteredProjects]);

  useEffect(() => {
    setActiveIndex((i) => Math.min(i, rows.length - 1));
  }, [rows.length]);

  function selectProjectRow(row: ProjectRow) {
    setError(null);
    setBranch("feature");
    // Default worktree OFF; only an existing git repo flips it on below. Setting
    // it explicitly here stops a `true` from a previously-picked git project
    // leaking into a create/add-path selection.
    setUseWorktree(false);
    if (row.kind === "create") {
      setMode("create");
      setQuery(trimmedQuery);
    } else if (row.kind === "add-path") {
      setMode("add-path");
      setQuery(trimmedQuery);
    } else {
      setMode("existing");
      setSelectedProject(row.project);
      // Default to a worktree for an existing git repo (the common case); a
      // non-git project can't have one, so leave it off there.
      setUseWorktree(row.project.isGit === true);
    }
    setPopupOpen(false);
  }

  function handleQueryChange(value: string) {
    setQuery(value);
    // R5: editing while in create/add-path mode returns to search + reopens popup.
    if (mode !== "search") setMode("search");
    setPopupOpen(true);
    setActiveIndex(0);
  }

  function clearSelection() {
    setSelectedProject(null);
    setQuery("");
    setMode("search");
    setUseWorktree(false);
    setError(null);
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
        break;
      default:
        break;
    }
  }

  // ── Directory combobox ───────────────────────────────────────────────────
  function scheduleDirFetch(path: string) {
    if (dirDebounceRef.current) clearTimeout(dirDebounceRef.current);
    dirDebounceRef.current = setTimeout(() => {
      void fetchDirSuggestions(path);
    }, DIR_DEBOUNCE_MS);
  }

  async function fetchDirSuggestions(path: string) {
    const reqId = ++dirReqIdRef.current;
    try {
      const res = await api.fsComplete(path);
      if (reqId !== dirReqIdRef.current) return; // stale response — a newer request superseded it
      setDirEntries(res.entries);
      setDirActiveIndex(0);
    } catch {
      if (reqId !== dirReqIdRef.current) return;
      setDirEntries([]);
    }
  }

  function handleParentDirChange(value: string) {
    setParentDir(value);
    setDirPopupOpen(true);
    if (value.trim()) {
      scheduleDirFetch(value);
    } else {
      setDirEntries([]);
    }
  }

  function selectDirEntry(path: string) {
    setParentDir(path);
    setDirPopupOpen(false);
    scheduleDirFetch(path);
  }

  function handleDirKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!dirPopupOpen || dirEntries.length === 0) {
      if (e.key === "ArrowDown" && dirEntries.length > 0) {
        setDirPopupOpen(true);
        e.preventDefault();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setDirActiveIndex((i) => Math.min(i + 1, dirEntries.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setDirActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter": {
        e.preventDefault();
        e.nativeEvent.stopImmediatePropagation();
        const entry = dirEntries[dirActiveIndex];
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
  const showConfig =
    mode === "add-path" ||
    mode === "existing" ||
    (mode === "create" && createNameValid);

  const worktreeDisabled = mode === "existing" && !!selectedProject && selectedProject.isGit === false;
  let worktreeHint: string | null = null;
  if (mode === "create") {
    worktreeHint = "Runs the agent on an isolated branch (git repo required — created above).";
  } else if (mode === "add-path") {
    worktreeHint = "Runs the agent on an isolated branch (the directory is made git-ready first).";
  } else if (mode === "existing" && selectedProject) {
    worktreeHint = selectedProject.isGit ? null : "Not a git repo — direct agent only.";
  }

  useEffect(() => {
    if (worktreeDisabled) setUseWorktree(false);
  }, [worktreeDisabled]);

  const showBranchFields = useWorktree && !worktreeDisabled;

  // ── Submit ────────────────────────────────────────────────────────────────

  async function submitCreate() {
    setError(null);
    const trimmedName = query.trim();
    const nameError = validateProjectName(trimmedName);
    if (nameError) {
      setError(nameError);
      return;
    }
    const trimmedBranch = branch.trim();
    if (useWorktree) {
      // Base is always `main` for a freshly-created project.
      const branchErr = validateBranchName(trimmedBranch, "main");
      if (branchErr) {
        setError(branchErr);
        return;
      }
    }

    setSubmitting(true);
    try {
      const body: CreateProjectBody = { name: trimmedName };
      const dir = expandHome(parentDir.trim(), homeDir);
      if (dir) body.dir = dir;

      const isJson = channel === "json";
      // JSON: register the project WITHOUT a one-shot startAgent (that path only
      // spawns a TTY session). The project is git-inited regardless, so we then
      // create the worktree/session on the json channel and send turn 1 —
      // mirroring the existing-project path. Terminal keeps the one-shot spawn.
      if (!isJson) {
        body.startAgent = {
          modeId,
          prompt: prompt.trim() || undefined,
          useWorktree,
          branch: useWorktree ? trimmedBranch : undefined,
        };
      }

      const result = await api.createProject(body);
      // The daemon already spawned the agent (terminal) or just registered the
      // project (json) — onCreated is a refresh hook, never a second spawn.
      onCreated?.(result.project);

      if (isJson) {
        let worktreeId: string | undefined;
        let sessionId: string | undefined;
        if (useWorktree && result.project.isGit) {
          const wt = await api.createWorktree({
            projectId: result.project.id,
            branch: trimmedBranch,
            baseBranch: result.project.defaultBranch,
            modeId,
            channel: "json",
          });
          worktreeId = wt.id;
          await sendJsonFirstTurn(api, wt.mainSessionId ?? `${wt.id}-m`, prompt, files);
        } else {
          const sess = await api.createDirectSession({
            target: "direct",
            projectId: result.project.id,
            type: "agent",
            modeId,
            channel: "json",
          });
          sessionId = sess.id;
          await sendJsonFirstTurn(api, sess.id, prompt, files);
        }
        handleClose();
        if (worktreeId) navigate(`/worktree/${worktreeId}`);
        else if (sessionId) navigate(`/session/${sessionId}`);
        return;
      }

      // Project created but no agent started (e.g. mode not found) — surface the
      // warning inline and keep the dialog open instead of silently closing.
      if (result.warning && !result.worktree && !result.session) {
        setError(result.warning);
        return;
      }
      handleClose();
      if (result.worktree) {
        navigate(`/worktree/${result.worktree.id}`);
      } else if (result.session) {
        navigate(`/session/${result.session.id}`);
      }
    } catch (err) {
      setError(errorMessage(err, "Failed to create project."));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitAddPath() {
    setError(null);
    const trimmedPath = query.trim();
    if (!trimmedPath) {
      setError("Path is required.");
      return;
    }
    if (!isAbsoluteQuery(trimmedPath)) {
      setError("Path must be absolute (start with / or ~/).");
      return;
    }
    const trimmedBranch = branch.trim();
    if (useWorktree) {
      // The base branch isn't known until the server registers + sets up the
      // project (could be the repo's existing default), so skip the collision
      // check here and let the daemon reject a real collision.
      const branchErr = validateBranchName(trimmedBranch);
      if (branchErr) {
        setError(branchErr);
        return;
      }
    }

    setSubmitting(true);
    try {
      const project = await api.addProject({ path: trimmedPath, setup: true });

      // The project is now registered. Adopt it into "existing" mode so that if
      // anything below fails (or the user retries), we DON'T re-POST /projects
      // (which would 409 "already registered") — the retry runs the existing
      // path against the already-registered project instead of dead-ending.
      onCreated?.(project);
      setSelectedProject(project);
      setMode("existing");

      // Setup failed (e.g. git unavailable) — the project is still registered,
      // but it's not git-ready, so we can't honor a worktree request. Surface
      // the warning and stop rather than silently downgrading to a direct agent.
      if (project.warning) {
        setError(project.warning);
        return;
      }

      const isJson = channel === "json";
      let worktreeId: string | undefined;
      let sessionId: string | undefined;
      if (useWorktree && project.isGit) {
        // JSON (Dec 8): create idle (no prompt in the body → no daemon
        // auto-enqueue), then upload staged files + send the prompt as turn 1.
        const wt = await api.createWorktree({
          projectId: project.id,
          branch: trimmedBranch,
          baseBranch: project.defaultBranch,
          modeId,
          ...(isJson
            ? { channel: "json" as const }
            : { prompt: prompt.trim() || undefined }),
        });
        worktreeId = wt.id;
        if (isJson) {
          await sendJsonFirstTurn(api, wt.mainSessionId ?? `${wt.id}-m`, prompt, files);
        }
      } else {
        const sess = await api.createDirectSession({
          target: "direct",
          projectId: project.id,
          type: "agent",
          modeId,
          ...(isJson
            ? { channel: "json" as const }
            : { prompt: prompt.trim() || undefined }),
        });
        sessionId = sess.id;
        if (isJson) {
          await sendJsonFirstTurn(api, sess.id, prompt, files);
        }
      }

      // onCreated already fired right after registration (above).
      handleClose();
      if (worktreeId) {
        navigate(`/worktree/${worktreeId}`);
      } else if (sessionId) {
        navigate(`/session/${sessionId}`);
      }
    } catch (err) {
      setError(errorMessage(err, "Failed to add project."));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitExisting() {
    setError(null);
    if (!selectedProject) return;
    const trimmedBranch = branch.trim();
    if (useWorktree && !worktreeDisabled) {
      // Collision is against the actually-selected base (e.g. "develop"), not a
      // hardcoded "main" — fall back to the project's default branch.
      const effectiveBase = baseBranch.trim() || selectedProject.defaultBranch || undefined;
      const branchErr = validateBranchName(trimmedBranch, effectiveBase);
      if (branchErr) {
        setError(branchErr);
        return;
      }
    }

    setSubmitting(true);
    try {
      const isJson = channel === "json";
      let worktreeId: string | undefined;
      let sessionId: string | undefined;
      if (useWorktree && !worktreeDisabled) {
        // JSON (Dec 8): create idle (no prompt in the body → no daemon
        // auto-enqueue), then upload staged files + send the prompt as turn 1
        // against the returned worktree's main agent.
        const wt = await api.createWorktree({
          projectId: selectedProject.id,
          branch: trimmedBranch,
          baseBranch: baseBranch.trim() || undefined,
          modeId,
          ...(isJson
            ? { channel: "json" as const }
            : { prompt: prompt.trim() || undefined }),
        });
        worktreeId = wt.id;
        if (isJson) {
          await sendJsonFirstTurn(api, wt.mainSessionId ?? `${wt.id}-m`, prompt, files);
        }
      } else {
        const sess = await api.createDirectSession({
          target: "direct",
          projectId: selectedProject.id,
          type: "agent",
          modeId,
          ...(isJson
            ? { channel: "json" as const }
            : { prompt: prompt.trim() || undefined }),
        });
        sessionId = sess.id;
        if (isJson) {
          await sendJsonFirstTurn(api, sess.id, prompt, files);
        }
      }

      onCreated?.(selectedProject);
      handleClose();
      if (worktreeId) {
        navigate(`/worktree/${worktreeId}`);
      } else if (sessionId) {
        navigate(`/session/${sessionId}`);
      }
    } catch (err) {
      setError(errorMessage(err, "Failed to start agent."));
    } finally {
      setSubmitting(false);
    }
  }

  function submit() {
    if (mode === "create") return void submitCreate();
    if (mode === "add-path") return void submitAddPath();
    if (mode === "existing") return void submitExisting();
  }

  const canSubmit =
    // A mode is required to spawn an agent — if modes failed to load, block
    // submit rather than sending an empty modeId the daemon will reject.
    !modeId
      ? false
      // Don't allow submit while the base-branch list is still loading — the
      // picked base would otherwise be empty and silently fall back server-side.
      : (showBranchFields && branchesLoading)
      ? false
      : mode === "create"
        ? createNameValid
        : mode === "add-path"
          ? query.trim().length > 0
          : mode === "existing"
            ? !!selectedProject
            : false;

  const primaryLabel = (() => {
    if (mode === "create") return submitting ? "Creating…" : "Create & Start";
    if (mode === "add-path") return submitting ? "Adding…" : "Add & Start";
    if (mode === "existing") return submitting ? "Starting…" : "Start";
    return "Continue";
  })();

  const activeDescendant =
    popupOpen && rows[activeIndex] ? `${projectListboxId}-${activeIndex}` : undefined;
  const dirActiveDescendant =
    dirPopupOpen && dirEntries[dirActiveIndex] ? `${dirListboxId}-${dirActiveIndex}` : undefined;

  return (
    <Dialog
      open={open}
      title="New Agent"
      onClose={handleClose}
      overlayClassName="dialog-overlay--flush"
      cardClassName="dialog-card--agent"
      footer={
        <div className="dialog-actions">
          <button type="button" className="btn btn--secondary" onClick={handleClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={submit}
            disabled={submitting || !canSubmit}
          >
            {primaryLabel}
          </button>
        </div>
      }
    >
      <div className="dialog-form new-project-form">
        {/* Project combobox */}
        <div className="form-field">
          <label htmlFor={projectFieldId}>Project</label>
          <div className="combobox-wrapper" ref={projectWrapperRef}>
            {mode === "existing" && selectedProject ? (
              <div className="project-chip">
                <span className="project-chip__icon" aria-hidden>◧</span>
                <span className="project-chip__name">{selectedProject.name}</span>
                <button
                  type="button"
                  className="project-chip__remove"
                  aria-label="Clear selected project"
                  onClick={clearSelection}
                >
                  ✕
                </button>
              </div>
            ) : (
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
                onFocus={() => {
                  // Only auto-open on focus while still searching — in
                  // create/add-path mode the popup reopens on edit (R5), not
                  // on a mere click to reposition the cursor.
                  if (mode === "search") setPopupOpen(true);
                }}
                onKeyDown={handleProjectKeyDown}
                autoFocus
              />
            )}

            {popupOpen && mode !== "existing" ? (
              <div className="combobox-popup" role="listbox" id={projectListboxId}>
                {showLeadingRow && showAddPathRow ? (
                  <button
                    type="button"
                    role="option"
                    tabIndex={-1}
                    id={`${projectListboxId}-0`}
                    aria-selected={activeIndex === 0}
                    className={`combobox-option${activeIndex === 0 ? " combobox-option--active" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectProjectRow({ kind: "add-path" });
                    }}
                    onMouseEnter={() => setActiveIndex(0)}
                  >
                    <span className="combobox-option__title">
                      <span aria-hidden>＋</span>
                      {`Add existing directory "${trimmedQuery}"`}
                    </span>
                    <span className="combobox-option__subtitle">not yet a vibe-station project</span>
                  </button>
                ) : showLeadingRow ? (
                  <button
                    type="button"
                    role="option"
                    tabIndex={-1}
                    id={`${projectListboxId}-0`}
                    aria-selected={activeIndex === 0}
                    className={`combobox-option${activeIndex === 0 ? " combobox-option--active" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectProjectRow({ kind: "create" });
                    }}
                    onMouseEnter={() => setActiveIndex(0)}
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
                ) : null}

                {filteredProjects.length > 0 ? (
                  <div className="combobox-popup__group-label" role="presentation">
                    USE EXISTING{trimmedQuery ? ` (${filteredProjects.length})` : ""}
                  </div>
                ) : null}
                {filteredProjects.map((p, i) => {
                  const idx = showLeadingRow ? i + 1 : i;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      id={`${projectListboxId}-${idx}`}
                      aria-selected={activeIndex === idx}
                      className={`combobox-option${activeIndex === idx ? " combobox-option--active" : ""}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectProjectRow({ kind: "existing", project: p });
                      }}
                      onMouseEnter={() => setActiveIndex(idx)}
                    >
                      <span className="combobox-option__title">
                        <span aria-hidden>▸</span>
                        {p.name}
                      </span>
                      <span className="combobox-option__subtitle">{p.path}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
          {mode === "existing" && selectedProject ? (
            <div className="form-hint">Using existing project at {selectedProject.path}</div>
          ) : null}
          {mode === "add-path" ? (
            <div className="form-hint">
              ⓘ Registers this directory and sets up git (init + .gitignore) if not already present.
            </div>
          ) : null}
          {mode === "create" && !createNameValid ? (
            <div className="field-error">{validateProjectName(trimmedQuery)}</div>
          ) : null}
        </div>

        {/* Directory combobox (create mode only, once the name is valid) */}
        {mode === "create" && createNameValid ? (
          <div className="form-field">
            <label htmlFor={dirFieldId}>Directory</label>
            <div className="combobox-wrapper" ref={dirWrapperRef}>
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
                  if (dirEntries.length > 0) setDirPopupOpen(true);
                }}
                onKeyDown={handleDirKeyDown}
              />
              {dirPopupOpen && dirEntries.length > 0 ? (
                <div className="combobox-popup" role="listbox" id={dirListboxId}>
                  {dirEntries.map((entry, i) => (
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
            <div className="new-agent__will-create">
              Will create <code className="new-agent__will-create-path">{willCreatePath}</code>
            </div>
            <div className="form-hint">
              ⓘ Sets up git (init + .gitignore) if not already present.
            </div>
          </div>
        ) : null}

        {/* Divider — only when the agent config below is shown */}
        {showConfig ? <hr className="form-divider" /> : null}

        {/* Agent section — shown once a project source is chosen (and, for
            create-new, once the name is valid). */}
        {showConfig ? (
          <div className="form-subsection">
            <div className="form-field">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={useWorktree}
                  disabled={worktreeDisabled}
                  onChange={(e) => setUseWorktree(e.target.checked)}
                />
                <span>Use worktree</span>
              </label>
              {worktreeHint ? <div className="form-hint">{worktreeHint}</div> : null}
            </div>

            {showBranchFields ? (
              <>
                <div className="form-field">
                  <label htmlFor="agent-branch">Branch</label>
                  <Input
                    id="agent-branch"
                    type="text"
                    placeholder="feature"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                  />
                </div>

                <div className="form-field">
                  <label htmlFor="agent-base-branch">Base branch</label>
                  {mode === "create" ? (
                    <>
                      <Input id="agent-base-branch" value="main" disabled readOnly />
                      <div className="form-hint">main will be initialized</div>
                    </>
                  ) : mode === "add-path" ? (
                    <>
                      <Input id="agent-base-branch" value="repository default" disabled readOnly />
                      <div className="form-hint">Uses the repo’s default branch (main is initialized if it isn’t a git repo).</div>
                    </>
                  ) : mode === "existing" && selectedProject?.isGit ? (
                    branchesLoading ? (
                      <div className="form-hint">Loading branches…</div>
                    ) : branches.length > 0 ? (
                      <Select
                        id="agent-base-branch"
                        value={baseBranch}
                        onChange={(e) => setBaseBranch(e.target.value)}
                      >
                        {branches.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <>
                        <Input
                          id="agent-base-branch"
                          placeholder="main"
                          value={baseBranch}
                          onChange={(e) => setBaseBranch(e.target.value)}
                        />
                        {branchesError ? (
                          <div className="form-hint">
                            Couldn’t load branches — type a base branch name above.
                          </div>
                        ) : (
                          <div className="form-hint">No branches found — type a base branch name.</div>
                        )}
                      </>
                    )
                  ) : null}
                </div>
              </>
            ) : null}

            <div className="form-field">
              <label htmlFor="agent-mode">Mode</label>
              <Select
                id="agent-mode"
                value={modeId}
                onChange={(e) => setModeId(e.target.value)}
              >
                {modes.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </div>

            <div className="form-field">
              <label htmlFor="agent-prompt">
                Initial prompt <span className="form-optional">(optional)</span>
              </label>
              <textarea
                id="agent-prompt"
                className="input"
                rows={3}
                placeholder="What should the agent work on?"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>

            <div className="form-field">
              <label>Channel</label>
              <div role="radiogroup" aria-label="Channel" style={{ display: "flex", gap: "var(--space-4)" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="agent-channel"
                    checked={channel === "terminal"}
                    onChange={() => setChannel("terminal")}
                  />
                  <span>⌨ Terminal</span>
                </label>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-2)",
                    cursor: jsonSupported ? "pointer" : "not-allowed",
                    opacity: jsonSupported ? 1 : 0.5,
                  }}
                >
                  <input
                    type="radio"
                    name="agent-channel"
                    checked={channel === "json"}
                    disabled={!jsonSupported}
                    onChange={() => setChannel("json")}
                  />
                  <span>💬 JSON chat</span>
                </label>
              </div>
              {!jsonSupported ? (
                <div className="form-hint">JSON chat not available for {selectedCli} yet.</div>
              ) : null}
            </div>

            {/* Attachments — shown for the JSON channel across all paths
                (brand-new project, add-path, and existing project). */}
            {channel === "json" && jsonSupported ? (
              <div className="form-field">
                <label>Attachments <span className="form-optional">(optional)</span></label>
                <AttachmentPicker files={files} onChange={setFiles} />
              </div>
            ) : null}
          </div>
        ) : null}

        {error && <div className="dialog-error">{error}</div>}
      </div>
    </Dialog>
  );
}
