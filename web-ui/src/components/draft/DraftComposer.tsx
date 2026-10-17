import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Folder, GitBranch, Lock, Play } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { ApiInstance } from "@/api";
import type { DraftAttachment } from "@/hooks/useAttachmentDrafts";
import type { CreateWorktreeBody, DraftConfig, Mode, Project, Session, Settings, SupportedCli, Worktree } from "@/api/types";
import { ApiError } from "@/api/errors";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { SkillEditor, useSoftKeyboardVisible, type SkillEditorHandle } from "../chat/SkillEditor";
import { ComposerShell, type HintItem } from "../chat/ComposerShell";
import { DraftHint } from "./DraftHint";
import { RichChatToggle } from "../chat/RichChatToggle";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";
import { NewModeDialog } from "../dialogs/NewModeDialog";
import { NonGitWorktreeDialog } from "../dialogs/NonGitWorktreeDialog";
import { ProjectCombobox } from "./ProjectCombobox";
import { DraftFieldRow } from "./DraftFieldRow";
import { ModePopover } from "./ModePopover";
import { isAbsoluteQuery, summarizeFields, type Mode_ } from "./draftComposerHelpers";
import { useShortPane } from "./useShortPane";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useGlobalDraftStore, type GlobalDraftState } from "@/store/globalDraftStore";
import { sendJsonFirstTurn } from "@/api/firstTurn";
import { useSkillCommands } from "@/hooks/useSkillCommands";
import { draftLabel } from "@/lib/sessionLabel";
import "./DraftComposer.css";

interface DraftComposerProps {
  api: ApiInstance;
  /** null = /draft/new (Tier 2, localStorage-only global draft). */
  draftSessionId: string | null;
  onStarted: (result: { worktreeId?: string; sessionId?: string }) => void;
  onDiscard: () => void;
}

const startHintItems: HintItem[] = [
  { keys: ["Enter"], label: "to start" },
  { keys: ["Shift + Enter"], label: "newline" },
];

/** Positional id for a staged (not-yet-uploaded) attachment chip. */
function stagedId(i: number): string {
  return `staged-${i}`;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** True when an `ApiError` carries the daemon's machine-readable `NOT_GIT` sentinel
 *  (422 `{"error":"NOT_GIT"}`, Phase 3). `ApiError.message` is the raw response body
 *  text, so the caller must `JSON.parse` it — there is no pre-parsed field. */
function isNotGitError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  try {
    const parsed = JSON.parse(err.message) as { error?: string };
    return parsed?.error === "NOT_GIT";
  } catch {
    return false;
  }
}

/**
 * Phase 4/3 (CUJ 3): the ORIGINAL request held while the NonGitWorktreeDialog
 * recovery flow runs. Discriminates the two call sites that can hit a 422
 * NOT_GIT so `handleNonGitConfirm` knows how to re-issue the retry:
 *  - `"worktree"`: `startTier2NewProject`'s direct `api.createWorktree(payload)`.
 *  - `"start-draft"`: `startTier1` / `startTier1ForProject`'s `api.startDraft(...)`,
 *    which the daemon now ALSO gates on the project being git (Tier 1). Holds the
 *    exact params so the same call can be re-issued unchanged after git-init.
 */
type PendingNonGit =
  | { kind: "worktree"; payload: CreateWorktreeBody }
  | {
      kind: "start-draft";
      projectId: string;
      sessionId: string;
      draftConfig: DraftConfig;
      prompt: string;
      skipAutoTurn: boolean;
    };

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
  // Terminal always means tmux now — the plain-pty option is gone from the UI.
  // A persisted `initialConfig.useTmux` (older drafts) is deliberately ignored.
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
  // Phase 4 (CUJ 3): the ORIGINAL request held while the NonGitWorktreeDialog
  // recovery flow runs. Non-null → the dialog is open. Discriminated union
  // covering BOTH worktree-creation entry points (Tier 2's createWorktree and
  // Tier 1's startDraft) that can hit a 422 NOT_GIT.
  const [pendingNonGitPayload, setPendingNonGitPayload] = useState<PendingNonGit | null>(null);

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
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  const { skillCommands, editorSeq, editorReady } = useSkillCommands(true, api);
  const softKeyboardVisible = useSoftKeyboardVisible();

  // ── Short-pane fold (Phase 2). ────────────────────────────────────────────
  const rootRef = useRef<HTMLDivElement>(null);
  const shortPane = useShortPane(rootRef);
  const [fieldsExpanded, setFieldsExpanded] = useState(false);

  // ── Worktree-tab join header data (entryPoint "tab"). ─────────────────────
  // The "+" on a worktree's agent tabs creates a draft with the project and
  // worktree already fixed — show them as a read-only join header, not rows.
  // Live status always resolves `sessionStates[id] ?? x.state` (AGENTS.md).
  const tabWorktree = useServerStore((s) => s.worktrees.find((w) => w.id === session?.worktreeId) ?? null);
  const sessionStates = useWorkspaceStore((s) => s.sessionStates);
  const allSessions = useServerStore((s) => s.sessions);
  const runningAgents = session?.worktreeId
    ? allSessions.filter(
        (x) =>
          x.worktreeId === session.worktreeId &&
          x.type === "agent" &&
          x.archivedAt == null &&
          x.id !== draftSessionId &&
          !["drafting", "exited", "done"].includes(sessionStates[x.id] ?? x.state),
      ).length
    : 0;
  // A project-folder direct-agent tab ("+" on a project's own agent tabs) has
  // no worktree — name the fixed project target instead of the worktree copy.
  const tabProjectName = projects.find((p) => p.id === session?.projectId)?.name ?? "this project";
  // Worktree tabs: name the worktree, falling back to the branch (Worktree.name
  // is optional and defaults to the branch). Used so the sub line doesn't
  // repeat the branch when name === branch (R1F-12).
  const joinName = tabWorktree?.name || tabWorktree?.branch || "this worktree";

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
  // Whether the user (or a prior explicit save) chose the channel on purpose.
  // Seeded from `channelExplicit` — NOT from `channel` merely being present,
  // since scaffold/autosave values populate `channel` for unrelated reasons
  // (B1). The mode-follow effect only overrides the channel while this is false.
  const channelTouchedRef = useRef(initialConfig?.channelExplicit === true);

  // ── Load static data on mount (modes, clis, projects). ────────────────────
  useEffect(() => {
    void (async () => {
      const [ms, cs] = await Promise.all([api.listModes(), api.getSupportedClis()]);
      setModes(ms);
      setClis(cs);
    })().catch(() => {});
    void api
      .listProjects()
      .then(setProjects)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    void api
      .getSettings()
      .then(setSettings)
      .catch(() => {})
      .finally(() => setSettingsLoaded(true));
  }, [api]);

  // Mode fallback once BOTH modes and settings have loaded (so there is no flash
  // of modes[0]): saved draft config wins (already in state), then the last-used
  // mode if it still exists, then the first mode.
  useEffect(() => {
    if (modeId || !settingsLoaded || modes.length === 0) return;
    const last = modes.find((m) => m.id === settings?.lastModeId);
    setModeId((last ?? modes[0])?.id ?? "");
  }, [modeId, modes, settings, settingsLoaded]);

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

  // Mode-follow: when the user hasn't explicitly chosen a channel, default it
  // to the selected mode's CLI's server-reported effective default (B2 — read
  // `defaultChannel`, never a CLI-id literal like `selectedCli === "agy"`).
  // Must NOT set `channelExplicit` — following the default is not a user choice.
  // Yields to the hard capability override below: a CLI that can't do Rich Chat
  // owns the choice via `jsonSupported`, so this effect never fights it (4.5/4.8).
  useEffect(() => {
    if (channelTouchedRef.current) return;
    if (!jsonSupported) return;
    const cli = clis.find((c) => c.id === selectedCli);
    const defaultChannel = cli?.defaultChannel ?? "json";
    setChannel(defaultChannel === "tmux" ? "terminal" : "json");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCli, clis, jsonSupported]);

  // ── Build the current DraftConfig. ────────────────────────────────────────
  const currentConfig = useMemo<DraftConfig>(() => {
    const base: DraftConfig = {
      entryPoint,
      modeId,
      channel: isJson ? "json" : "tmux",
      channelExplicit: channelTouchedRef.current,
    };
    if (entryPoint === "worktree") {
      base.worktreeChoice = worktreeChoice;
      if (worktreeChoice === "existing") {
        if (existingWorktreeId) base.existingWorktreeId = existingWorktreeId;
      } else {
        if (branch.trim()) base.branch = branch.trim();
        if (baseBranch.trim()) base.baseBranch = baseBranch.trim();
      }
    } else if (entryPoint === "global" || entryPoint === "direct") {
      base.useWorktree = useWorktree;
      if (useWorktree) {
        // BUG FIX: the New/Existing worktree radios and the worktree
        // `<Select>` render for entryPoint "global"/"direct" too (see the
        // `entryPoint !== "tab" && useWorktree` guard below), but this
        // branch used to never serialize `worktreeChoice`/
        // `existingWorktreeId` — only the `entryPoint === "worktree"`
        // branch above did. So picking "Existing worktree" + a specific
        // worktree here was pure unsent React state: `startTier1` posted
        // `draftConfig: {entryPoint, useWorktree:true, branch?,
        // baseBranch?}` with no trace of which worktree the user chose,
        // and both daemons' `/start` handlers treat
        // `useWorktree === true` with no `worktreeChoice` as "create a
        // new worktree" — silently ignoring the selection and always
        // minting a brand-new one. Live-reproduced against :7141 (and
        // confirmed identical against the TS daemon — this was never a
        // Rust-port-specific bug).
        base.worktreeChoice = worktreeChoice;
        if (worktreeChoice === "existing") {
          if (existingWorktreeId) base.existingWorktreeId = existingWorktreeId;
        } else {
          if (branch.trim()) base.branch = branch.trim();
          if (baseBranch.trim()) base.baseBranch = baseBranch.trim();
        }
      }
    }
    return base;
  }, [entryPoint, modeId, isJson, worktreeChoice, existingWorktreeId, branch, baseBranch, useWorktree]);

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
      let res: Awaited<ReturnType<typeof api.startDraft>>;
      try {
        res = await api.startDraft(draftSessionId, {
          draftPrompt: prompt,
          draftConfig: currentConfig,
          skipAutoTurn: isJson,
        });
      } catch (err) {
        // The daemon ALSO gates Tier-1 startDraft on the project being git
        // (mirrors POST /worktrees's NOT_GIT). Route it to the same recovery
        // dialog (CUJ 3) instead of the generic error. `finally` below resets
        // `submitting`; the dialog drives git-init + the retry.
        if (isNotGitError(err) && session?.projectId) {
          setPendingNonGitPayload({
            kind: "start-draft",
            projectId: session.projectId,
            sessionId: draftSessionId,
            draftConfig: currentConfig,
            prompt,
            skipAutoTurn: isJson,
          });
          return;
        }
        throw err;
      }
      // Register a brand-new worktree (entryPoint "worktree"/"new") in the
      // store immediately, the same way startTier2NewProject does for its own
      // createWorktree call below — this response is the only place the web-ui
      // learns about it before the `worktree:created` WS broadcast lands.
      // Without this, `handleAgentCreated`'s store lookup can lose that race
      // (reconnect, event ordering) and `activeWorktreeId` never gets set, so
      // the pane stays blank until a manual refresh re-fetches everything over
      // REST (issue: new-worktree draft sometimes never shows its terminal).
      if (res.worktree) {
        useServerStore.getState().applyWorktreeCreated(res.worktree);
      }
      // Optimistic channel patch: the session record's `channel` field only
      // flips server-side on start (draftConfig.channel holds the pending
      // choice until then), and the `session:updated` broadcast reporting the
      // new value can lose the race with the navigation below. Without this,
      // AgentPaneSlot briefly reads the stale pre-start channel (default
      // "json") and renders Rich Chat during the starting state even for an
      // agent started on the Terminal channel.
      // `modeId` is patched for the same reason: the tab icon resolves from it, and
      // the record's `modeId` is only set server-side on start.
      useServerStore.getState().applySessionUpdated(draftSessionId, {
        channel: currentConfig.channel,
        ...(currentConfig.modeId ? { modeId: currentConfig.modeId } : {}),
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
        });
        project = created.project;
        warning = created.warning;
      }

      if (warning) {
        setError(warning);
        return;
      }

      if (useWorktree) {
        const payload: CreateWorktreeBody = {
          projectId: project.id,
          branch: branch.trim() || undefined,
          baseBranch: baseBranch.trim() || project.defaultBranch,
          modeId,
          prompt: prompt.trim(),
          // Pass the channel the user actually selected — this path used to
          // hardcode `"json"`, which turned a Terminal-selected agent into a
          // Rich Chat agent (the pane showed ChatPane even though the sidebar
          // showed a terminal session spawning).
          channel: currentConfig.channel,
          skipAutoTurn: true,
        };
        try {
          const wt = await api.createWorktree(payload);
          await finishWorktreeStart(wt);
        } catch (err) {
          if (isNotGitError(err)) {
            // Non-git project (422 NOT_GIT): hold the ORIGINAL payload and hand
            // off to the recovery dialog (CUJ 3) instead of silently falling
            // through to a direct session. Abort this submit; the dialog drives
            // git-init + the retry, and `finally` below resets `submitting`.
            setPendingNonGitPayload({ kind: "worktree", payload });
            return;
          }
          throw err;
        }
      } else {
        const sess = await api.createDirectSession({
          target: "direct",
          projectId: project.id,
          type: "agent",
          modeId,
          prompt: prompt.trim(),
          channel: currentConfig.channel,
          skipAutoTurn: true,
        });
        const sessionId = sess.id;
        // Same as the worktree branch: register the direct session before
        // navigating so the /session/:id route doesn't bounce to the dashboard
        // (the redirect effect redirects when the session isn't in the store).
        useServerStore.getState().applySessionCreated(sess);
        if (isJson && sessionId) {
          await sendJsonFirstTurn(api, sessionId, prompt.trim(), files);
        }
        clearGlobalDraft();
        if (isTier1 && draftSessionId && !session?.projectId) {
          useServerStore.getState().applySessionDeleted(draftSessionId);
          void api.terminateSession(draftSessionId).catch(() => {});
        }
        committedRef.current = true;
        onStarted({ worktreeId: undefined, sessionId });
      }
    } catch (err) {
      setError(errorMessage(err, "Failed to create project."));
    } finally {
      setSubmitting(false);
    }
  }

  // Phase 4 (CUJ 3): the shared post-success handler for the worktree branch of
  // `startTier2NewProject` AND the NonGitWorktreeDialog retry. Registers the
  // freshly-created worktree, then runs the same trailing promotion steps a
  // direct session takes (JSON first turn, global-draft cleanup, onStarted).
  async function finishWorktreeStart(wt: Worktree) {
    // Register the worktree in the store before navigating so URL sync
    // (and the subsequent `session:created` WS event) can select it. Without
    // this the /worktree/:id read effect found nothing and the write effect
    // rewrote the URL to a bare /worktree, so the UI never landed on the
    // newly created agent (issue: "UI didn't navigate to the new agent").
    useServerStore.getState().applyWorktreeCreated(wt);
    const sessionId = wt.mainSessionId ?? undefined;
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
    onStarted({ worktreeId: wt.id, sessionId: sessionId ?? undefined });
  }

  // Phase 4 (CUJ 3): git-init the project, then apply THIS client's own HTTP
  // response to the store immediately (`isGit`/`defaultBranch`) rather than
  // waiting on our own `ProjectUpdated` WS echo — per the "Draft promotion...
  // HTTP response must be self-sufficient" invariant. Rejects on git-init
  // failure so the dialog shows an inline error (CUJ 3 error path).
  async function gitInitAndApply(projectId: string) {
    const res = await api.gitInitProject(projectId);
    const cur = useServerStore.getState().projects.find((p) => p.id === projectId);
    if (cur) {
      useServerStore.getState().applyProjectUpdated({
        ...cur,
        isGit: res.isGit,
        ...(res.defaultBranch ? { defaultBranch: res.defaultBranch } : {}),
      });
    }
    return res;
  }

  // Phase 4 (CUJ 3): NonGitWorktreeDialog "Run git init and continue". Git-inits
  // the project, then re-issues the SAME original request — no flow restart
  // (R10) — for whichever entry point hit NOT_GIT (Tier 2 createWorktree or
  // Tier 1 startDraft).
  async function handleNonGitConfirm() {
    const pending = pendingNonGitPayload;
    if (!pending) return;
    await gitInitAndApply(pending.kind === "worktree" ? pending.payload.projectId : pending.projectId);
    if (pending.kind === "worktree") {
      const wt = await api.createWorktree(pending.payload);
      setPendingNonGitPayload(null);
      await finishWorktreeStart(wt);
    } else {
      const res = await api.startDraft(pending.sessionId, {
        draftPrompt: pending.prompt,
        draftConfig: pending.draftConfig,
        skipAutoTurn: pending.skipAutoTurn,
      });
      setPendingNonGitPayload(null);
      // Same post-start handling `startTier1`/`startTier1ForProject` run:
      // register a freshly-created worktree, patch the session record, JSON
      // first turn, then onStarted — so the pane lands on the agent.
      if (res.worktree) {
        useServerStore.getState().applyWorktreeCreated(res.worktree);
      }
      useServerStore.getState().applySessionUpdated(pending.sessionId, {
        channel: pending.draftConfig.channel,
        ...(pending.draftConfig.modeId ? { modeId: pending.draftConfig.modeId } : {}),
      });
      if (pending.skipAutoTurn) {
        await sendJsonFirstTurn(api, pending.sessionId, pending.prompt, files);
      }
      committedRef.current = true;
      onStarted({ worktreeId: res.worktreeId, sessionId: pending.sessionId });
    }
  }

  async function handleStart() {
    // Remember the mode for the next draft (fire-and-forget).
    if (modeId) void api.updateSettings({ lastModeId: modeId }).catch(() => {});
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
          try {
            await api.startDraft(sess.id, {
              draftPrompt: prompt.trim(),
              draftConfig: currentConfig,
              skipAutoTurn: isJson,
            });
          } catch (startErr) {
            if (isNotGitError(startErr)) {
              // The daemon gates Tier-1 startDraft on the project being git.
              // Route to the recovery dialog (CUJ 3) — do NOT delete the
              // session here: the retry re-issues startDraft on the SAME one.
              setPendingNonGitPayload({
                kind: "start-draft",
                projectId: p.id,
                sessionId: sess.id,
                draftConfig: currentConfig,
                prompt: prompt.trim(),
                skipAutoTurn: isJson,
              });
              return;
            }
            throw startErr;
          }
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

  const showWorktreeFields = entryPoint !== "tab" && useWorktree;

  // Whether the draft has acquired a target (project/worktree) yet. For a
  // global draft with nothing chosen, only the Project row shows (W1).
  const hasTarget = Boolean(projectId) || comboMode === "create" || comboMode === "add-path";
  const showFieldRows = entryPoint !== "global" || hasTarget;

  // Short-pane fold: when the pane is short and a target is chosen, the field
  // rows collapse into a one-line summary (they stay MOUNTED so the
  // ProjectCombobox keeps its create/add-path state; only `hidden` toggles).
  const folded = shortPane && hasTarget && entryPoint !== "tab" && !fieldsExpanded;
  const summary = summarizeFields({
    projectName:
      (isTier1 ? projects.find((p) => p.id === session?.projectId)?.name : selectedProject?.name) ??
      (comboMode === "add-path" ? newProjectAbsPath : null),
    newProject: comboMode === "create",
    useWorktree,
    worktreeChoice,
    existingBranch: worktrees.find((w) => w.id === existingWorktreeId)?.branch ?? null,
    baseBranch,
  });

  // Staged attachments: drafts have no live session to upload into (Tier 2
  // has no session at all), so files stay as `File`s until Start, where
  // `sendJsonFirstTurn` uploads them against the started session — the same
  // contract the old AttachmentPicker had. Chips reuse the composer's
  // `DraftAttachment` shape with a positional id.
  const stagedChips: DraftAttachment[] = files.map((f, i) => ({
    attachment: { id: stagedId(i), name: f.name, path: "", size: f.size, mime: f.type || "application/octet-stream" },
  }));
  // Only Rich Chat delivers a first-turn upload; a Terminal agent gets the
  // prompt alone, so say so rather than silently dropping staged files.
  const attachmentNotice =
    !isJson && files.length > 0 ? "Attachments are only sent to Rich Chat agents — switch Rich Chat on or remove them." : null;

  return (
    <div className={"draft-composer" + (shortPane ? " draft-composer--short" : "")} ref={rootRef}>
      <div className="draft-composer__body">
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
        <div className="draft-composer__stage-inner">
          <img src="/logo.svg" alt="" className="draft-composer__logo" aria-hidden />
          <h2 className="draft-composer__caption">New agent</h2>
          <div className="draft-composer__box">
            {shortPane && hasTarget && entryPoint !== "tab" ? (
              <button
                type="button"
                className="draft-composer__summary"
                aria-expanded={!folded}
                aria-controls="draft-composer-rows"
                onClick={() => setFieldsExpanded((v) => !v)}
              >
                <span className="draft-composer__summary-text">{summary}</span>
                <span className="draft-row__link">{folded ? "Edit" : "Done"}</span>
              </button>
            ) : null}
            <div className="draft-composer__rows" id="draft-composer-rows" hidden={folded}>
              {/* Project field — hidden entirely for entryPoint "tab": the
                  draft was created from the "+" on this worktree's own agent
                  tabs, so its project (and worktree) are already fixed and
                  implicit from where the button lives. Nothing here is ever
                  user-changeable for this entry point (there is no "Use
                  project folder instead" detach button for "tab" either, a few
                  lines below), so showing a fixed, unremovable chip added
                  nothing but visual noise. */}
              {entryPoint === "tab" ? (
                !session?.worktreeId ? (
                  // A project-folder direct-agent tab (no worktree): name the
                  // project the agent runs in, not the generic worktree copy.
                  <div className="draft-join" data-testid="draft-join">
                    <Folder size={16} aria-hidden />
                    <div className="draft-join__text">
                      <div className="draft-join__name">{tabProjectName}</div>
                      <div className="draft-join__sub">runs in the project folder</div>
                    </div>
                  </div>
                ) : (
                  <div className="draft-join" data-testid="draft-join">
                    <GitBranch size={16} aria-hidden />
                    <div className="draft-join__text">
                      <div className="draft-join__name">{joinName}</div>
                      <div className="draft-join__sub">{tabWorktree && tabWorktree.branch !== joinName ? tabWorktree.branch + " · " : ""}joins this worktree</div>
                    </div>
                    {runningAgents > 0 ? (
                      <span className="draft-join__run">
                        {runningAgents} agent{runningAgents === 1 ? "" : "s"} running
                      </span>
                    ) : null}
                  </div>
                )
              ) : (!isTier1 || !session?.projectId) ? (
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
                <DraftFieldRow label="Project">
                  <span aria-hidden>◧</span>
                  <span className="draft-row__project-name">
                    {projects.find((p) => p.id === session?.projectId)?.name ?? "…"}
                  </span>
                  {entryPoint === "direct" || entryPoint === "worktree" ? (
                    <span role="img" aria-label="Locked to this project" className="draft-row__lock">
                      <Lock size={13} aria-hidden />
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="draft-row__icon-btn"
                    aria-label="Remove project"
                    onClick={() => void handleClearProject()}
                  >
                    ✕
                  </button>
                </DraftFieldRow>
              )}
              {entryPoint === "worktree" ? (
                <div className="draft-row draft-row--detach">
                  <div className="draft-row__line">
                    <span className="draft-row__label" />
                    <span className="draft-row__control">
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
                    </span>
                  </div>
                </div>
              ) : null}

              {/* Use worktree checkbox — "global"/"direct" entry points only.
                  For entryPoint "worktree" this checkbox would be a no-op:
                  `currentConfig`'s "worktree" branch never reads `useWorktree` (it
                  always submits entryPoint "worktree"), so toggling it only hid/
                  showed the branch fields below while silently doing nothing to
                  what Start actually submits — confusingly, "Use project folder
                  instead" (above) is the ONLY control that really switches this
                  entry point to a direct/no-worktree session. Showing both
                  invited exactly that confusion (issue: unchecking this box for
                  a worktree-entry-point draft looked like it opted out of a
                  worktree, but Start still created one). */}
              {(entryPoint === "global" || entryPoint === "direct") && showFieldRows ? (
                <DraftFieldRow label="Use worktree">
                  <span className="draft-row__hint">{useWorktree ? "isolated branch" : "runs in the project folder"}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={useWorktree}
                    aria-label="Use worktree"
                    className="draft-switch"
                    onClick={() => setUseWorktree(!useWorktree)}
                  >
                    <span className="draft-switch__track" aria-hidden>
                      <span className="draft-switch__thumb" />
                    </span>
                  </button>
                </DraftFieldRow>
              ) : null}

              {/* Worktree choice — shown for all entry points when Use worktree is checked */}
              {entryPoint !== "tab" && useWorktree && showFieldRows ? (
                <DraftFieldRow label="Worktree">
                  <div className="draft-seg" role="radiogroup" aria-label="Worktree">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={worktreeChoice === "new"}
                      aria-label="New worktree"
                      className="draft-seg__btn"
                      onClick={() => setWorktreeChoice("new")}
                    >
                      New
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={worktreeChoice === "existing"}
                      aria-label="Existing worktree"
                      className="draft-seg__btn"
                      onClick={() => setWorktreeChoice("existing")}
                    >
                      Existing
                    </button>
                  </div>
                </DraftFieldRow>
              ) : null}

              {entryPoint !== "tab" && useWorktree && showFieldRows && worktreeChoice === "existing" ? (
                <DraftFieldRow label="Join">
                  <Select
                    aria-label="Worktree to join"
                    value={existingWorktreeId}
                    onChange={(e) => setExistingWorktreeId(e.target.value)}
                    style={{ width: 260, maxWidth: "100%", height: 26, padding: "0 8px", fontSize: "var(--font-size-sm)" }}
                  >
                    {worktrees.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.branch}
                      </option>
                    ))}
                  </Select>
                </DraftFieldRow>
              ) : null}

              {/* Branch fields */}
              {showFieldRows && showWorktreeFields && worktreeChoice === "new" ? (
                <DraftFieldRow label="Branch">
                  <Input
                    aria-label="Branch"
                    placeholder="auto from your prompt (optional)"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    style={{ width: 260, maxWidth: "100%", height: 26, padding: "0 8px", fontSize: "var(--font-size-sm)" }}
                  />
                </DraftFieldRow>
              ) : null}
              {showFieldRows && showWorktreeFields && worktreeChoice === "new" ? (
                <DraftFieldRow label="Base">
                  {branches.length > 0 ? (
                    <Select
                      aria-label="Base branch"
                      value={baseBranch}
                      onChange={(e) => setBaseBranch(e.target.value)}
                      style={{ width: 260, maxWidth: "100%", height: 26, padding: "0 8px", fontSize: "var(--font-size-sm)" }}
                    >
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
                      style={{ width: 260, maxWidth: "100%", height: 26, padding: "0 8px", fontSize: "var(--font-size-sm)" }}
                    />
                  )}
                </DraftFieldRow>
              ) : null}
            </div>

            {error ? <div className="draft-composer__error" role="alert">{error}</div> : null}

            <div className="draft-composer__composer">
              {editorReady ? (
                <ComposerShell
                  className="chat-composer--draft"
                  attachments={stagedChips}
                  onRemoveAttachment={(id) => setFiles((prev) => prev.filter((_, i) => stagedId(i) !== id))}
                  onFocusEditor={() => editorRef.current?.focus()}
                  error={attachmentNotice}
                  onFiles={(added) => setFiles((prev) => [...prev, ...added])}
                  attachDisabled={submitting || !isJson}
                  attachTitle={isJson ? "Attach files" : "Attachments are only sent to Rich Chat agents"}
                  toolbarStart={
                    <RichChatToggle
                      checked={isJson}
                      disabled={!jsonSupported || submitting}
                      {...(!jsonSupported
                        ? { disabledReason: `Rich Chat not available for ${selectedCli ?? "this CLI"} yet — this agent will run in a Terminal` }
                        : {})}
                      onChange={(on) => {
                        channelTouchedRef.current = true;
                        setChannel(on ? "json" : "terminal");
                      }}
                    />
                  }
                  toolbarEnd={
                    <>
                      <ModePopover
                        modes={modes}
                        modeId={modeId}
                        channel={isJson ? "json" : "pty"}
                        disabled={submitting}
                        onSelect={setModeId}
                        onNewMode={() => setNewModeOpen(true)}
                      />
                      <button
                        type="button"
                        className="btn btn--primary chat-composer__send"
                        onClick={() => void handleStart()}
                        disabled={submitting || !prompt.trim()}
                        aria-label="Start agent"
                      >
                        <Play size={12} />
                        <span className="draft-composer__start-label">{submitting ? "Starting…" : "Start"}</span>
                      </button>
                    </>
                  }
                >
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
                </ComposerShell>
              ) : null}
            </div>
          </div>

          <div className="chat-composer__hint draft-composer__hint">
            <DraftHint
              items={
                softKeyboardVisible
                  ? [
                      { keys: ["Enter"], label: "newline" },
                      { keys: ["Ctrl/⌘ + Enter"], label: "to start" },
                    ]
                  : startHintItems
              }
              showDrop={isJson}
            />
          </div>
        </div>
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

      <NonGitWorktreeDialog
        open={pendingNonGitPayload !== null}
        onConfirm={handleNonGitConfirm}
        onCancel={() => setPendingNonGitPayload(null)}
      />

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
