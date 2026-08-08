import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Mode, SupportedCli, Worktree } from "@/api/types";
import { ApiError } from "@/api/errors";
import { Dialog } from "./Dialog";
import { Input } from "../ui/Input";
import { Radio } from "../ui/Radio";
import { Select } from "../ui/Select";
import { AttachmentPicker } from "../chat/AttachmentPicker";
import { NewModeDialog } from "./NewModeDialog";
import { sendJsonFirstTurn } from "@/api/firstTurn";

interface NewSessionDialogProps {
  open: boolean;
  onClose: () => void;
  api: ApiInstance;
  projectId: string;
  projectName: string;
  onCreated?: () => void;
  /** Prefill for the initial prompt (e.g. carried over from another dialog). */
  initialPrompt?: string;
  /** Preselect this mode on open when it exists in the mode list. */
  initialModeId?: string;
}

export function NewSessionDialog({
  open,
  onClose,
  api,
  projectId,
  projectName,
  onCreated,
  initialPrompt: initialPromptProp,
  initialModeId,
}: NewSessionDialogProps) {
  const [wtChoice, setWtChoice] = useState<"new" | "existing">("new");
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [existingWtId, setExistingWtId] = useState("");
  const [newWtBranch, setNewWtBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [modes, setModes] = useState<Mode[]>([]);
  const [modeId, setModeId] = useState("");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [useTmux, setUseTmux] = useState(true);
  const [channel, setChannel] = useState<"terminal" | "json">("terminal");
  const [files, setFiles] = useState<File[]>([]);
  const [clis, setClis] = useState<SupportedCli[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [newModeOpen, setNewModeOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (initialPromptProp) setInitialPrompt(initialPromptProp);
    setChannel("terminal");
    setFiles([]);
    void (async () => {
      const [wts, ms, cs] = await Promise.all([
        api.listWorktrees(projectId),
        api.listModes(),
        api.getSupportedClis(),
      ]);
      setWorktrees(wts);
      setModes(ms);
      setClis(cs);
      if (wts[0]) setExistingWtId(wts[0].id);
      const preferred =
        initialModeId && ms.some((m) => m.id === initialModeId)
          ? initialModeId
          : ms[0]?.id;
      if (preferred) setModeId(preferred);
    })();
    // Fetch branches independently — a failure here must NOT break worktree/mode
    // loading. On error we fall back to a free-text branch input.
    void (async () => {
      setBranchesError(null);
      try {
        const res = await api.listProjectBranches(projectId);
        setBranches(res.branches);
        // Coerce baseBranch to a value present in the rendered options so the
        // controlled <select> never points at a missing <option>. defaultBranch
        // may be null (non-git) — fall back to the first branch / empty string.
        const preferred = res.defaultBranch ?? "";
        const def =
          preferred && res.branches.includes(preferred)
            ? preferred
            : (res.branches[0] ?? preferred);
        setBaseBranch(def);
      } catch (err) {
        setBranches([]);
        // Detail logged (not surfaced) — UI shows a concise fallback message.
        console.warn("Failed to load project branches:", err);
        setBranchesError(
          err instanceof ApiError
            ? err.message || `Could not load branches (HTTP ${err.status})`
            : err instanceof Error
              ? err.message
              : String(err),
        );
      }
    })();
  }, [open, api, projectId, initialPromptProp, initialModeId]);

  // JSON channel is only offered for CLIs whose plugin supportsJson (daemon
  // gates this too). Default to allowed until capabilities load.
  const selectedCli = modes.find((m) => m.id === modeId)?.cli;
  const jsonSupported =
    selectedCli == null || clis.length === 0
      ? true
      : (clis.find((c) => c.id === selectedCli)?.supportsJson ?? true);
  const isJson = channel === "json";

  // If the selected mode's CLI can't run JSON, snap back to terminal.
  useEffect(() => {
    if (!jsonSupported && channel === "json") setChannel("terminal");
  }, [jsonSupported, channel]);

  async function submit() {
    setError(null);
    if (wtChoice === "existing" && !existingWtId) {
      setError("Select a worktree.");
      return;
    }
    setSubmitting(true);
    try {
      if (wtChoice === "new") {
        // POST /worktrees already spawns the main `m` agent session with the
        // selected mode + prompt. No additional createSession needed.
        if (isJson) {
          // JSON: create the worktree's agent idle (channel:json, no prompt in
          // the body → no daemon auto-enqueue), then upload staged files + send
          // the prompt as turn 1 against the main agent.
          const wt = await api.createWorktree({
            projectId,
            branch: newWtBranch.trim() || undefined,
            modeId: modeId || "mode-1",
            baseBranch: baseBranch.trim() || undefined,
            channel: "json",
          });
          if (wt.mainSessionId) {
            await sendJsonFirstTurn(api, wt.mainSessionId, initialPrompt, files);
          } else {
            // No main session id came back (unexpected) — never guess one
            // (ids are independently generated, Decision 1); the worktree
            // still exists and is usable, just without a first turn queued.
            console.error(`[NewSessionDialog] worktree ${wt.id} has no mainSessionId — skipping first-turn send`);
          }
        } else {
          // KNOWN RACE (unlike the JSON path above, which creates idle and
          // only sends turn 1 — with attachment ids — once the upload
          // response comes back): the daemon spawns the CLI with `prompt`
          // baked into argv as soon as createWorktree's route handler runs,
          // fire-and-forget, *before* this call even returns. The claude
          // UserPromptSubmit hook that reads pending-uploads can fire before
          // this uploadAttachments call (a separate later round trip)
          // finishes writing them, so attachments can be missing from turn 1.
          // See daemon/src/agent-plugins/claude.ts (composeLaunchPrompt /
          // setupWorkspaceHooks) and daemon/src/routes/worktrees.ts
          // (fire-and-forget runMainSpawnJob). Fixing this for real needs a
          // queue-based delivery for the initial terminal prompt (mirroring
          // how /sessions/:id/chat is "always accepted" for JSON), since
          // /sessions/:id/input 409s if the CLI process isn't registered yet.
          const wt = await api.createWorktree({
            projectId,
            branch: newWtBranch.trim() || undefined,
            modeId: modeId || "mode-1",
            baseBranch: baseBranch.trim() || undefined,
            prompt: initialPrompt.trim() || undefined,
            useTmux,
          });
          if (files.length > 0 && wt.mainSessionId) {
            await api.uploadAttachments(wt.mainSessionId, files);
          }
        }
      } else {
        if (isJson) {
          const sess = await api.createSession({
            worktreeId: existingWtId,
            modeId: modeId || null,
            type: "agent",
            channel: "json",
          });
          await sendJsonFirstTurn(api, sess.id, initialPrompt, files);
        } else {
          // Known race with the initial prompt — see the comment on the
          // `createWorktree` branch above.
          const sess = await api.createSession({
            worktreeId: existingWtId,
            modeId: modeId || null,
            type: "agent",
            prompt: initialPrompt.trim() || undefined,
            useTmux,
          });
          if (files.length > 0) {
            await api.uploadAttachments(sess.id, files);
          }
        }
      }
      onCreated?.();
      onClose();
    } catch (err) {
      // Surface server errors (and offline daemon) in-dialog so the user gets
      // feedback instead of a silently dismissed click.
      const msg =
        err instanceof ApiError
          ? err.message || `Request failed (HTTP ${err.status})`
          : err instanceof Error
            ? err.message
            : String(err);
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
    <Dialog
      open={open}
      title={`New session — ${projectName}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="button" onClick={() => void submit()} disabled={submitting}>
            {submitting ? "Creating…" : "Create"}
          </button>
        </>
      }
    >
      <div className="field-label">Worktree</div>
      <Radio
        name="wt"
        label="Existing worktree"
        checked={wtChoice === "existing"}
        onChange={() => setWtChoice("existing")}
      />
      {wtChoice === "existing" ? (
        <Select
          aria-label="Worktree"
          value={existingWtId}
          onChange={(e) => setExistingWtId(e.target.value)}
        >
          {worktrees.map((w) => (
            <option key={w.id} value={w.id}>
              {w.branch}
            </option>
          ))}
        </Select>
      ) : null}
      <Radio
        name="wt"
        label="New worktree"
        checked={wtChoice === "new"}
        onChange={() => setWtChoice("new")}
      />
      {wtChoice === "new" ? (
        <>
          <div className="field-label">
            Branch <span className="form-optional">(optional)</span>
          </div>
          <Input
            aria-label="New worktree branch"
            placeholder="auto-generated from your prompt if left blank"
            value={newWtBranch}
            onChange={(e) => setNewWtBranch(e.target.value)}
          />
          <div className="field-label">Base branch</div>
          {branches.length > 0 ? (
            <Select
              aria-label="Base branch"
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
                aria-label="Base branch"
                placeholder="main"
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
              />
              {branchesError ? (
                <div className="field-error">
                  Couldn’t load branches — type a base branch name above.
                </div>
              ) : (
                <div className="field-label" style={{ fontWeight: "normal", color: "var(--fg-muted)" }}>
                  No branches found — type a base branch name.
                </div>
              )}
            </>
          )}
        </>
      ) : null}
      <div className="field-label">Mode</div>
      <Select value={modeId} onChange={(e) => setModeId(e.target.value)} aria-label="Mode">
        {modes.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </Select>
      <button type="button" style={{ alignSelf: "flex-start", marginTop: "var(--space-2)" }} onClick={() => setNewModeOpen(true)}>
        + New mode
      </button>
      <div className="field-label" style={{ marginTop: "var(--space-4)" }}>Initial prompt <span style={{ color: "var(--fg-muted)", fontWeight: "normal" }}>(optional)</span></div>
      <textarea
        data-autofocus
        className="field-textarea"
        aria-label="Initial prompt"
        placeholder="Describe what you want the agent to do…"
        rows={4}
        value={initialPrompt}
        onChange={(e) => setInitialPrompt(e.target.value)}
      />
      <div className="field-label" style={{ marginTop: "var(--space-4)" }}>
        Attachments <span style={{ color: "var(--fg-muted)", fontWeight: "normal" }}>(optional)</span>
      </div>
      <AttachmentPicker files={files} onChange={setFiles} />
      <div className="field-label" style={{ marginTop: "var(--space-4)" }}>Channel</div>
      <div role="radiogroup" aria-label="Channel" style={{ display: "flex", gap: "var(--space-4)" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", cursor: "pointer" }}>
          <input
            type="radio"
            name="new-session-channel"
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
            name="new-session-channel"
            checked={channel === "json"}
            disabled={!jsonSupported}
            onChange={() => setChannel("json")}
          />
          <span>💬 Rich Chat</span>
        </label>
      </div>
      {!jsonSupported ? (
        <div className="field-label" style={{ marginTop: "var(--space-2)", fontWeight: "normal", color: "var(--fg-muted)" }}>
          Rich Chat not available for {selectedCli} yet.
        </div>
      ) : null}
      {!isJson && (
        <div style={{ marginTop: "var(--space-4)", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <input
            type="checkbox"
            id="use-tmux-checkbox"
            checked={useTmux}
            onChange={(e) => setUseTmux(e.target.checked)}
          />
          <label htmlFor="use-tmux-checkbox" style={{ cursor: "pointer", userSelect: "none" }}>
            Use tmux (recommended — survives daemon restart, better concurrent device support)
          </label>
        </div>
      )}
      {error ? <div className="field-error">{error}</div> : null}
    </Dialog>
    {newModeOpen && (
      <NewModeDialog
        open
        onClose={() => setNewModeOpen(false)}
        api={api}
        onSaved={async () => {
          const ms = await api.listModes();
          setModes(ms);
          if (ms[ms.length - 1]) setModeId(ms[ms.length - 1]!.id);
          setNewModeOpen(false);
        }}
      />
    )}
    </>
  );
}
