import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ApiInstance } from "@/api";
import type { DraftConfig, Mode, Project, Session, Settings, SupportedCli, Worktree } from "@/api/types";
import { ApiError } from "@/api/errors";
import { Input } from "../ui/Input";
import { Radio } from "../ui/Radio";
import { Select } from "../ui/Select";
import { SkillEditor, type SkillEditorHandle } from "../chat/SkillEditor";
import { AttachmentPicker } from "../chat/AttachmentPicker";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";
import { NewModeDialog } from "../dialogs/NewModeDialog";
import { ProjectCombobox } from "./ProjectCombobox";
import { isAbsoluteQuery, type Mode_ } from "./draftComposerHelpers";
import { useServerStore } from "@/hooks/useServerStore";
import { useGlobalDraftStore, type GlobalDraftState } from "@/store/globalDraftStore";
import { sendJsonFirstTurn } from "@/api/firstTurn";
import { useSkillCommands } from "@/hooks/useSkillCommands";
import { draftLabel } from "@/lib/sessionLabel";
import "./DraftComposer.css";

interface DraftComposerProps {
  api: ApiInstance;
  /** null = /draft/new (Tier 2, localStorage-only global draft). */
  draftSessionId: string | null;
  onStarted: (result: { worktreeId?: string; sessionId: string }) => void;
  onDiscard: () => void;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Full-pane draft composer for the Instant Draft Agent feature — replaces all
 * four "New Agent" modal dialogs with a single config form. Rendered directly
 * in the main content area for `/draft/*` routes (Decision 4), NOT via the
 * pane portal system.
 *
 * Tier 1 (draftSessionId non-null): a server-persisted drafting session in
 * `useServerStore`. Prompt/config changes are debounced and saved via
 * `api.updateDraft`; [▶ Start] promotes via `api.startDraft`.
 *
 * Tier 2 (/draft/new): a localStorage-only global draft in `useGlobalDraftStore`.
 * Selecting an existing project upgrades it to Tier 1 (`api.createDraftSession`);
 * a brand-new project name creates the project + worktree/session directly on
 * Start (Decision 7).
 */
export function DraftComposer({ api, draftSessionId, onStarted, onDiscard }: DraftComposerProps) {
  const isTier1 = draftSessionId != null;

  // Tier 1 source of truth — the server-persisted drafting session.
  const session = useServerStore((s) =>
    isTier1 && draftSessionId ? (s.sessions.find((x) => x.id === draftSessionId) ?? null) : null,
  );
  // Tier 2 source of truth — the localStorage global draft.
  const globalDraft = useGlobalDraftStore((s) => s.draft);
  const setGlobalDraft = useGlobalDraftStore((s) => s.setDraft);
  const clearGlobalDraft = useGlobalDraftStore((s) => s.clearDraft);

  // Tier 1: gate rendering until the draft session has synced from the daemon.
  // On a hard refresh `useServerStore` starts empty (`sessions: []`), so the
  // session is briefly null while REST sync is in flight. If we mounted the
  // form now, `<SkillEditor>` would seed `initialText=""`, and Lexical never
  // re-reads `initialText` once mounted — so when `session` arrived and
  // `setPrompt` ran, the textarea would stay visually empty (the refresh bug).
  // Rendering a loading placeholder instead guarantees `DraftComposerInner`
  // (and thus `<SkillEditor>`) mounts only once `session` is present, so its
  // synchronous state initialization reads the restored draft on the very
  // first frame. It also avoids flashing the fallback draft settings.
  if (isTier1 && !session) {
    return <div className="draft-composer draft-composer--loading" aria-busy="true" />;
  }

  return (
    <DraftComposerInner
      api={api}
      isTier1={isTier1}
      draftSessionId={draftSessionId}
      session={session}
      globalDraft={globalDraft}
      setGlobalDraft={setGlobalDraft}
      clearGlobalDraft={clearGlobalDraft}
      onStarted={onStarted}
      onDiscard={onDiscard}
    />
  );
}

interface DraftComposerInnerProps extends DraftComposerProps {
  isTier1: boolean;
  /** For Tier 1, guaranteed non-null (the wrapper gates on it). Null for Tier 2. */
  session: Session | null;
  globalDraft: GlobalDraftState["draft"];
  setGlobalDraft: GlobalDraftState["setDraft"];
  clearGlobalDraft: GlobalDraftState["clearDraft"];
}

function DraftComposerInner({
  api,
  isTier1,
  draftSessionId,
  session,
  globalDraft,
  setGlobalDraft,
  clearGlobalDraft,
  onStarted,
  onDiscard,
}: DraftComposerInnerProps) {
  const navigate = useNavigate();

  // Entry point is fixed per route: from the persisted draftConfig for Tier 1,
  // or "global" for /draft/new (Tier 2).
  const entryPoint = isTier1 ? (session?.draftConfig?.entryPoint ?? "direct") : "global";

  // The restored draft config. Synchronously available the moment the inner
  // component mounts — for Tier 1 the wrapper guarantees `session` is present;
  // for Tier 2 `globalDraft` is read once from the persisted store.
  const initialConfig = isTier1 ? (session?.draftConfig ?? null) : (globalDraft?.draftConfig ?? null);
  const initialPrompt = isTier1 ? (session?.draftPrompt ?? "") : (globalDraft?.draftPrompt ?? "");

  // Initialize every field synchronously from `initialConfig` so that when
  // `<SkillEditor>` mounts (driven by `editorReady`), its `initialText` is
  // already the restored prompt — no async prefill lag for the editor to miss.
  const [modeId, setModeId] = useState(initialConfig?.modeId ?? "");
  const [modes, setModes] = useState<Mode[]>([]);
  const [clis, setClis] = useState<SupportedCli[]>([]);
  const [channel, setChannel] = useState<"json" | "terminal">(
    initialConfig?.channel && initialConfig.channel !== "json" ? "terminal" : "json",
  );
  const [useTmux, setUseTmux] = useState(initialConfig?.useTmux ?? true);
  const [worktreeChoice, setWorktreeChoice] = useState<"new" | "existing">(initialConfig?.worktreeChoice ?? "new");
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [existingWorktreeId, setExistingWorktreeId] = useState(initialConfig?.existingWorktreeId ?? "");
  const [branch, setBranch] = useState(initialConfig?.branch ?? "");
  const [baseBranch, setBaseBranch] = useState(initialConfig?.baseBranch ?? "");
  const [branches, setBranches] = useState<string[]>([]);
  const [useWorktree, setUseWorktree] = useState(initialConfig?.useWorktree ?? true);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newModeOpen, setNewModeOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Global entry only — the currently selected existing project, and whether
  // the user is creating a brand-new project by name.
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);

  // Tier 2: tracks what the combobox has resolved.
  const [comboMode, setComboMode] = useState<Mode_>("search");
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectParentDir, setNewProjectParentDir] = useState("");
  const [newProjectAbsPath, setNewProjectAbsPath] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);

  const { skillCommands, editorSeq, editorReady } = useSkillCommands(true, api);

  // Debounced save timer for prompt/config changes.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Editor ref for autofocus on mount.
  const editorRef = useRef<SkillEditorHandle | null>(null);
  // Set true once Start or Discard succeeds, so the unmount cleanup skips
  // flushing a stale save (which would 403 after Start, or persist discarded data).
  const committedRef = useRef(false);
  // Latest prompt/config for the unmount flush (the cleanup effect would
  // otherwise capture stale values at render time).
  const latestSaveDataRef = useRef<{ prompt: string; currentConfig: DraftConfig | null }>(null);
  // Guard so selecting a project (which navigates away) only runs once even if
  // the combobox fires onSelectExisting more than once before unmount.
  const selectingRef = useRef(false);

  // ── Load static data on mount (modes, clis, projects). ────────────────────
  useEffect(() => {
    void (async () => {
      const [ms, cs] = await Promise.all([api.listModes(), api.getSupportedClis()]);
      setModes(ms);
      setClis(cs);
      if (ms[0] && !modeId) setModeId(ms[0].id);
    })().catch(() => {});
    void api
      .listProjects()
      .then(setProjects)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    void api.getSettings().then(setSettings).catch(() => {});
  }, [api]);

  // ── Load per-entry-point data (worktrees / branches). ─────────────────────
  const projectId = isTier1 ? (session?.projectId ?? null) : (selectedProject?.id ?? null);

  useEffect(() => {
    if (!projectId) return;
    void api
      .listWorktrees(projectId)
      .then((wts) => {
        setWorktrees(wts);
        if (wts[0] && !existingWorktreeId) setExistingWorktreeId(wts[0].id);
      })
      .catch(() => {});
    if (entryPoint === "worktree" || (entryPoint === "direct" && useWorktree) || (entryPoint === "global" && useWorktree)) {
      void (async () => {
        try {
          const res = await api.listProjectBranches(projectId);
          setBranches(res.branches);
          const preferred = res.defaultBranch ?? "";
          const def = preferred && res.branches.includes(preferred) ? preferred : (res.branches[0] ?? preferred);
          if (!baseBranch) setBaseBranch(def);
        } catch {
          setBranches([]);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryPoint, projectId, useWorktree, worktreeChoice]);

  // Rich Chat availability gated on the selected mode's CLI.
  const selectedCli = modes.find((m) => m.id === modeId)?.cli;
  const jsonSupported =
    selectedCli == null || clis.length === 0
      ? true
      : (clis.find((c) => c.id === selectedCli)?.supportsJson ?? true);
  const isJson = channel === "json";

  useEffect(() => {
    if (!jsonSupported && channel === "json") setChannel("terminal");
  }, [jsonSupported, channel]);

  // ── Build the current DraftConfig. ────────────────────────────────────────
  const currentConfig = useMemo<DraftConfig>(() => {
    const base: DraftConfig = {
      entryPoint,
      modeId,
      channel: isJson ? "json" : useTmux ? "tmux" : "pty",
    };
    if (entryPoint === "worktree") {
      base.worktreeChoice = worktreeChoice;
      if (worktreeChoice === "existing") {
        if (existingWorktreeId) base.existingWorktreeId = existingWorktreeId;
      } else {
        if (branch.trim()) base.branch = branch.trim();
        if (baseBranch.trim()) base.baseBranch = baseBranch.trim();
      }
      base.useTmux = useTmux;
    } else if (entryPoint === "global") {
      base.useWorktree = useWorktree;
      if (useWorktree) {
        if (branch.trim()) base.branch = branch.trim();
        if (baseBranch.trim()) base.baseBranch = baseBranch.trim();
      }
      base.useTmux = useTmux;
    } else if (entryPoint === "direct") {
      base.useWorktree = useWorktree;
      if (useWorktree) {
        if (branch.trim()) base.branch = branch.trim();
        if (baseBranch.trim()) base.baseBranch = baseBranch.trim();
      }
      base.useTmux = useTmux;
    } else if (entryPoint === "tab") {
      base.useTmux = useTmux;
    }
    return base;
  }, [entryPoint, modeId, isJson, useTmux, worktreeChoice, existingWorktreeId, branch, baseBranch, useWorktree]);

  // Keep the unmount flush's source of truth in sync with the live values.
  useEffect(() => {
    latestSaveDataRef.current = { prompt, currentConfig };
  }, [prompt, currentConfig]);

  // ── Debounced prompt/config save. ─────────────────────────────────────────
  const flushSave = useCallback((opts?: { keepalive?: boolean }) => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (isTier1 && draftSessionId) {
      void api.updateDraft(draftSessionId, { draftPrompt: prompt, draftConfig: currentConfig }, opts).catch(() => {});
    } else {
      setGlobalDraft({ draftPrompt: prompt, draftConfig: currentConfig });
    }
  }, [api, isTier1, draftSessionId, prompt, currentConfig, setGlobalDraft]);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushSave, 1200);
  }, [flushSave]);

  const handlePromptChange = useCallback(
    (text: string) => {
      setPrompt(text);
      if (isTier1 && draftSessionId) {
        useServerStore.getState().applySessionUpdated(draftSessionId, { draftPrompt: text });
      } else {
        setGlobalDraft({ draftPrompt: text, draftConfig: currentConfig });
      }
      scheduleSave();
    },
    [isTier1, draftSessionId, currentConfig, setGlobalDraft, scheduleSave],
  );

  // Save on config changes too (debounced).
  useEffect(() => {
    scheduleSave();
  }, [currentConfig, scheduleSave]);

  // Flush on hard refresh / tab close — `keepalive: true` lets the browser
  // finish this fetch even after the page starts unloading, unlike a plain
  // fetch which gets aborted. The unmount-cleanup effect below handles the
  // SPA-navigation case (the app stays alive long enough for a normal fetch).
  useEffect(() => {
    const handler = () => {
      if (committedRef.current) return;
      flushSave({ keepalive: true });
    };
    window.addEventListener("pagehide", handler);
    window.addEventListener("beforeunload", handler);
    return () => {
      window.removeEventListener("pagehide", handler);
      window.removeEventListener("beforeunload", handler);
    };
  }, [flushSave]);

  // Flush the pending save on unmount instead of just cancelling the debounce
  // timer — otherwise unsaved prompt/config changes are lost when the user
  // navigates away before the 2000ms debounce fires. Skipped after a successful
  // Start or Discard (committedRef) to avoid 403s / stale saves.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (!committedRef.current && latestSaveDataRef.current) {
        const { prompt: latestPrompt, currentConfig: latestConfig } = latestSaveDataRef.current;
        if (latestConfig) {
          if (isTier1 && draftSessionId) {
            void api.updateDraft(draftSessionId, { draftPrompt: latestPrompt, draftConfig: latestConfig }).catch(() => {});
          } else {
            setGlobalDraft({ draftPrompt: latestPrompt, draftConfig: latestConfig });
          }
        }
      }
    };
  }, [isTier1, draftSessionId, api, setGlobalDraft]);

  // Autofocus the prompt editor once Lexical is ready.
  useEffect(() => {
    if (editorReady) {
      setTimeout(() => editorRef.current?.focus(), 0);
    }
  }, [editorReady]);

  // ── Global entry: select an existing project → upgrade to Tier 1. ─────────
  async function handleSelectProject(p: Project) {
    if (selectingRef.current) return;
    selectingRef.current = true;
    setSelectedProject(p);
    setComboMode("existing");
    setNewProjectName("");
    setError(null);
    if (p.isGit) setUseWorktree(true);
    try {
      const created = await api.createDraftSession({
        target: "direct",
        projectId: p.id,
        type: "agent",
        draftPrompt: prompt,
        draftConfig: { ...currentConfig, entryPoint: "global" },
      });
      useServerStore.getState().applySessionCreated(created);
      // For global Tier-1 sessions: terminate the server draft we are "graduating" from.
      // For Tier-2 sessions: clearGlobalDraft handles cleanup (terminateSession is a no-op here).
      if (isTier1 && draftSessionId && !session?.projectId) {
        void api.terminateSession(draftSessionId).catch(() => {});
      }
      clearGlobalDraft();
      navigate(`/draft/${created.id}`);
    } catch (err) {
      setError(errorMessage(err, "Failed to create draft."));
    } finally {
      selectingRef.current = false;
    }
  }

  // ── Tier 1, has a project: demote back to a Tier 2 (project-less) draft. ──
  function handleClearProject() {
    if (!draftSessionId) return;
    const rest = { ...currentConfig };
    delete rest.existingWorktreeId;
    delete rest.worktreeChoice;
    delete rest.branch;
    delete rest.baseBranch;
    const preserved = {
      draftPrompt: prompt,
      draftConfig: { ...rest, entryPoint: "global" as const, useWorktree: true },
    };
    committedRef.current = true;
    useServerStore.getState().applySessionDeleted(draftSessionId); // optimistic: drop from sidebar now
    setGlobalDraft(preserved);
    navigate("/draft/new", { replace: true });
    void api.terminateSession(draftSessionId).catch((e) => {
      console.error("Failed to terminate draft session:", e);
    });
  }

  // ── Start handlers. ───────────────────────────────────────────────────────
  async function startTier1() {
    if (!draftSessionId) return;
    if (!prompt.trim()) {
      setError("Enter a prompt before starting.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.startDraft(draftSessionId, {
        draftPrompt: prompt,
        draftConfig: currentConfig,
        skipAutoTurn: isJson,
      });
      if (isJson) {
        await sendJsonFirstTurn(api, draftSessionId, prompt, files);
      }
      committedRef.current = true;
      onStarted({ worktreeId: res.worktreeId, sessionId: draftSessionId });
    } catch (err) {
      setError(errorMessage(err, "Failed to start agent."));
    } finally {
      setSubmitting(false);
    }
  }

  async function startTier2NewProject(opts: {
    selectedProject: Project | null;
    newProjectName: string;
    parentDir: string;
    addPath: string | null;
  }) {
    if (opts.selectedProject) {
      // submitExisting path — create a draft session and promote to Tier 1.
      if (!prompt.trim()) {
        setError("Enter a prompt before starting.");
        return;
      }
      setError(null);
      setSubmitting(true);
      try {
        const created = await api.createDraftSession({
          target: "direct",
          projectId: opts.selectedProject.id,
          type: "agent",
          draftPrompt: prompt.trim(),
          draftConfig: { ...currentConfig, entryPoint: "global" },
        });
        useServerStore.getState().applySessionCreated(created);
        clearGlobalDraft();
        committedRef.current = true;
        navigate(`/draft/${created.id}`);
      } catch (err) {
        setError(errorMessage(err, "Failed to create draft."));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (!prompt.trim()) {
      setError("Enter a prompt before starting.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      let project: Project;
      let warning: string | undefined;
      if (opts.addPath) {
        // submitAddPath path — register an existing directory as a project.
        const trimmedPath = opts.addPath.trim();
        if (!isAbsoluteQuery(trimmedPath)) {
          setError("Path must be absolute (start with / or ~/).");
          return;
        }
        const added = await api.addProject({ path: trimmedPath, setup: true });
        project = added;
        warning = added.warning;
      } else {
        // submitCreate path — create a brand-new project by name.
        const name = opts.newProjectName.trim();
        if (!name) {
          setError("Enter a project name.");
          return;
        }
        const created = await api.createProject({
          name,
          ...(opts.parentDir.trim() ? { dir: opts.parentDir.trim() } : {}),
          ...(!isJson
            ? {
                startAgent: {
                  modeId,
                  prompt: prompt.trim(),
                  useWorktree,
                  branch: useWorktree ? branch.trim() || undefined : undefined,
                },
              }
            : {}),
        });
        project = created.project;
        warning = created.warning;
      }

      if (warning) {
        setError(warning);
        return;
      }

      let worktreeId: string | undefined;
      let sessionId: string | undefined;
      if (useWorktree && project.isGit) {
        const wt = await api.createWorktree({
          projectId: project.id,
          branch: branch.trim() || undefined,
          baseBranch: baseBranch.trim() || project.defaultBranch,
          modeId,
          prompt: prompt.trim(),
          channel: "json",
          skipAutoTurn: true,
        });
        worktreeId = wt.id;
        sessionId = wt.mainSessionId ?? undefined;
      } else {
        const sess = await api.createDirectSession({
          target: "direct",
          projectId: project.id,
          type: "agent",
          modeId,
          prompt: prompt.trim(),
          channel: "json",
          skipAutoTurn: true,
        });
        sessionId = sess.id;
      }
      if (isJson && sessionId) {
        await sendJsonFirstTurn(api, sessionId, prompt.trim(), files);
      }
      clearGlobalDraft();
      // If we were started from a server-backed global draft (Tier 1, no project),
      // terminate that orphaned draft record now that we've promoted to a real session.
      if (isTier1 && draftSessionId && !session?.projectId) {
        useServerStore.getState().applySessionDeleted(draftSessionId);
        void api.terminateSession(draftSessionId).catch(() => {});
      }
      committedRef.current = true;
      onStarted({ worktreeId, sessionId: sessionId ?? project.id });
    } catch (err) {
      setError(errorMessage(err, "Failed to create project."));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStart() {
    // A global Tier 1 draft (server-backed but no project yet) cannot be started
    // directly — it must first acquire a project the same way Tier 2 does.
    if (isTier1 && session?.projectId) return startTier1();
    // Tier 2 or global Tier 1 with an existing project selected → promoted Tier 1 path.
    if (comboMode === "existing" && selectedProject) return startTier1ForProject(selectedProject, { andStart: true });
    return startTier2NewProject({
      selectedProject,
      newProjectName,
      parentDir: newProjectParentDir,
      addPath: comboMode === "add-path" ? newProjectAbsPath : null,
    });
  }

  // Fallback path for when handleSelectProject's create fails — the user can
  // still hit Start manually while remaining on /draft/new.
  async function startTier1ForProject(p: Project, opts?: { andStart?: boolean }) {
    setSubmitting(true);
    setError(null);
    try {
      const sess = await api.createDraftSession({
        target: "direct",
        projectId: p.id,
        type: "agent",
        draftPrompt: prompt.trim(),
        draftConfig: { ...currentConfig, entryPoint: "global" },
      });
      useServerStore.getState().applySessionCreated(sess);
      committedRef.current = true;
      if (opts?.andStart) {
        try {
          await api.startDraft(sess.id, {
            draftPrompt: prompt.trim(),
            draftConfig: currentConfig,
            skipAutoTurn: isJson,
          });
          if (isJson) {
            await sendJsonFirstTurn(api, sess.id, prompt.trim(), files);
          }
          onStarted({ sessionId: sess.id });
        } catch (startErr) {
          // Draft was created but failed to start — remove it from the store
          // so it doesn't linger as an orphan; server copy will be GC'd on reconnect.
          useServerStore.getState().applySessionDeleted(sess.id);
          committedRef.current = false;
          throw startErr;
        }
      } else {
        navigate(`/draft/${sess.id}`);
      }
    } catch (e) {
      setError(errorMessage(e, "Failed to create draft."));
    } finally {
      setSubmitting(false);
    }
  }

  const title = "New agent";

  const sessionProject = isTier1
    ? (projects.find((p) => p.id === session?.projectId) ?? null)
    : selectedProject;

  const showWorktreeFields = entryPoint !== "tab" && useWorktree && (sessionProject?.isGit ?? true);

  return (
    <div className="draft-composer">
      {isTier1 ? (
        <button
          type="button"
          className="draft-composer__discard"
          onClick={() => setConfirmDiscard(true)}
          aria-label="Discard draft"
        >
          ✕
        </button>
      ) : null}
      <div className="draft-composer__body">
        <div className="draft-composer__spacer" />
        <div className="draft-composer__hero">
          <div className="draft-composer__appname">
            vibe station <span className="draft-composer__appversion">v0.0.0</span>
          </div>
          <img src="/logo.svg" alt="" className="draft-composer__logo" aria-hidden />
          <h2 className="draft-composer__title">{title}</h2>
        </div>
        <div className="draft-composer__fields">
          {/* Project field */}
          {(!isTier1 || !session?.projectId) ? (
            <ProjectCombobox
              api={api}
              projects={projects}
              settings={settings}
              onSelectExisting={(p) => { void handleSelectProject(p); }}
              onNewName={(name, dir) => {
                setNewProjectName(name);
                setNewProjectParentDir(dir);
                setComboMode("create");
              }}
              onAddPath={(path) => {
                setNewProjectAbsPath(path);
                setComboMode("add-path");
              }}
              onClear={() => {
                setSelectedProject(null);
                setComboMode("search");
                setNewProjectName("");
                setNewProjectParentDir("");
                setNewProjectAbsPath("");
                setUseWorktree(true);
                setBranch("");
                setBaseBranch("");
                setWorktreeChoice("new");
                setExistingWorktreeId("");
                setWorktrees([]);
                setBranches([]);
              }}
            />
          ) : (
            <>
              <div className="draft-composer__field">
                <div className="draft-composer__field-label">Project</div>
                <div className="project-chip">
                  <span className="project-chip__icon" aria-hidden>◧</span>
                  <span className="project-chip__name">
                    {projects.find((p) => p.id === session?.projectId)?.name ?? "…"}
                  </span>
                  <button
                    type="button"
                    className="project-chip__remove"
                    aria-label="Remove project"
                    onClick={() => void handleClearProject()}
                  >
                    ✕
                  </button>
                </div>
              </div>
              {entryPoint === "worktree" ? (
                <button
                  type="button"
                  className="draft-composer__detach-worktree"
                  aria-label="Use existing project folder instead of a new worktree"
                  onClick={() => {
                    if (!draftSessionId) return;
                    const newConfig = { ...currentConfig, entryPoint: "direct" as const, useWorktree: false };
                    // Optimistic update so entryPoint flips immediately — no intermediate state
                    useServerStore.getState().applySessionUpdated(draftSessionId, { draftConfig: newConfig });
                    void api.updateDraft(draftSessionId, {
                      draftPrompt: prompt,
                      draftConfig: newConfig,
                    }).catch(() => {
                      if (currentConfig) {
                        useServerStore.getState().applySessionUpdated(draftSessionId, { draftConfig: currentConfig });
                      }
                    });
                  }}
                >
                  Use project folder instead
                </button>
              ) : null}
            </>
          )}

          {/* Use worktree checkbox — all non-tab entry points */}
          {entryPoint !== "tab" ? (
            <div className="draft-composer__field">
              <label className="draft-composer__checkbox">
                <input
                  type="checkbox"
                  checked={useWorktree}
                  onChange={(e) => setUseWorktree(e.target.checked)}
                />
                Use worktree (isolated branch)
              </label>
            </div>
          ) : null}

          {/* Worktree choice — shown for all entry points when Use worktree is checked */}
          {entryPoint !== "tab" && useWorktree ? (
            <div className="draft-composer__field">
              <div className="draft-composer__field-label">Worktree</div>
              <Radio
                name="wt-choice"
                label="New worktree"
                checked={worktreeChoice === "new"}
                onChange={() => setWorktreeChoice("new")}
              />
              <Radio
                name="wt-choice"
                label="Existing worktree"
                checked={worktreeChoice === "existing"}
                onChange={() => setWorktreeChoice("existing")}
              />
              {worktreeChoice === "existing" ? (
                <Select
                  value={existingWorktreeId}
                  onChange={(e) => setExistingWorktreeId(e.target.value)}
                  style={{ marginTop: "var(--space-2)" }}
                >
                  {worktrees.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.branch}
                    </option>
                  ))}
                </Select>
              ) : null}
            </div>
          ) : null}

          {/* Branch fields */}
          {showWorktreeFields && worktreeChoice === "new" ? (
            <div className="draft-composer__field">
              <div className="draft-composer__field-label">
                Branch <span style={{ color: "var(--fg-muted)", fontWeight: "normal" }}>(optional)</span>
              </div>
              <Input
                aria-label="Branch"
                placeholder="auto-generated from your prompt if left blank"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
              <div className="draft-composer__field-label" style={{ marginTop: "var(--space-3)" }}>
                Base branch
              </div>
              {branches.length > 0 ? (
                <Select aria-label="Base branch" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)}>
                  {branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  aria-label="Base branch"
                  placeholder="main"
                  value={baseBranch}
                  onChange={(e) => setBaseBranch(e.target.value)}
                />
              )}
            </div>
          ) : null}

          {/* Mode field — keep existing markup, show for all entry points */}
          <div className="draft-composer__field">
            <div className="draft-composer__field-label">Mode</div>
            <div className="draft-composer__mode-row">
              <Select aria-label="Mode" value={modeId} onChange={(e) => setModeId(e.target.value)}>
                {modes.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
              <button type="button" className="draft-composer__new-mode" onClick={() => setNewModeOpen(true)}>
                + New mode
              </button>
            </div>
          </div>

          {/* Channel field — keep existing markup verbatim */}
          <div className="draft-composer__field">
            <div className="draft-composer__field-label">Channel</div>
            <div role="radiogroup" aria-label="Channel" className="draft-composer__radio-row">
              <label
                className="draft-composer__radio-label"
                style={{ opacity: jsonSupported ? 1 : 0.5, cursor: jsonSupported ? "pointer" : "not-allowed" }}
              >
                <input
                  type="radio"
                  name="draft-channel"
                  checked={channel === "json"}
                  disabled={!jsonSupported}
                  onChange={() => setChannel("json")}
                />
                💬 Rich Chat
              </label>
              <label className="draft-composer__radio-label">
                <input
                  type="radio"
                  name="draft-channel"
                  checked={channel === "terminal"}
                  onChange={() => setChannel("terminal")}
                />
                ⌨ Terminal
              </label>
            </div>
            {!jsonSupported ? (
              <div className="draft-composer__hint">Rich Chat not available for {selectedCli} yet.</div>
            ) : null}
            {!isJson ? (
              <label className="draft-composer__checkbox">
                <input type="checkbox" checked={useTmux} onChange={(e) => setUseTmux(e.target.checked)} />
                Use tmux (recommended — survives daemon restart, better concurrent device support)
              </label>
            ) : null}
          </div>

          {/* Attachments */}
          <div className="draft-composer__field">
            <div className="draft-composer__field-label">Attachments</div>
            <AttachmentPicker files={files} onChange={setFiles} />
          </div>
        </div>

        {error ? <div className="draft-composer__error">{error}</div> : null}
      </div>

      <div className="draft-composer__bar">
        {editorReady ? (
          <div className="chat-composer__row">
            <div className="chat-composer__field">
              <SkillEditor
                ref={editorRef}
                editorKey={`draft-${draftSessionId ?? "new"}-${editorSeq}`}
                initialText={prompt}
                commands={skillCommands}
                ariaLabel="Prompt"
                placeholder="What should this agent do?"
                className="chat-composer__textarea"
                onChangeText={handlePromptChange}
                onSubmit={() => void handleStart()}
                disabled={submitting}
              />
            </div>
            <div className="chat-composer__actions">
              <button
                type="button"
                className="chat-composer__send"
                onClick={() => void handleStart()}
                disabled={submitting || !prompt.trim()}
                aria-label="Start agent"
              >
                {submitting ? "…" : "▶"}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {newModeOpen ? (
        <NewModeDialog
          open
          api={api}
          onClose={() => setNewModeOpen(false)}
          onSaved={async () => {
            const ms = await api.listModes();
            setModes(ms);
            if (ms[ms.length - 1]) setModeId(ms[ms.length - 1]!.id);
            setNewModeOpen(false);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={confirmDiscard}
        title="Discard draft?"
        message={
          session?.name?.trim() || prompt.trim()
            ? `Discard draft “${session?.name?.trim() || draftLabel(prompt)}”? The draft prompt and settings will be removed.`
            : "Discard this draft? The draft prompt and settings will be removed."
        }
        confirmLabel="Discard"
        onConfirm={() => {
          setConfirmDiscard(false);
          committedRef.current = true;
          onDiscard();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </div>
  );
}
