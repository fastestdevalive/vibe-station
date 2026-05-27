import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Mode, Worktree } from "@/api/types";
import { ApiError } from "@/api/errors";
import { Dialog } from "./Dialog";
import { Input } from "../ui/Input";
import { Radio } from "../ui/Radio";
import { Select } from "../ui/Select";
import { NewModeDialog } from "./NewModeDialog";

interface NewSessionDialogProps {
  open: boolean;
  onClose: () => void;
  api: ApiInstance;
  projectId: string;
  projectName: string;
  onCreated?: () => void;
}

export function NewSessionDialog({
  open,
  onClose,
  api,
  projectId,
  projectName,
  onCreated,
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
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [newModeOpen, setNewModeOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const [wts, ms] = await Promise.all([
        api.listWorktrees(projectId),
        api.listModes(),
      ]);
      setWorktrees(wts);
      setModes(ms);
      if (wts[0]) setExistingWtId(wts[0].id);
      if (ms[0]) setModeId(ms[0].id);
    })();
    // Fetch branches independently — a failure here must NOT break worktree/mode
    // loading. On error we fall back to a free-text branch input.
    void (async () => {
      setBranchesError(null);
      try {
        const res = await api.listProjectBranches(projectId);
        setBranches(res.branches);
        // Coerce baseBranch to a value present in the rendered options so the
        // controlled <select> never points at a missing <option>.
        const def = res.branches.includes(res.defaultBranch)
          ? res.defaultBranch
          : (res.branches[0] ?? res.defaultBranch);
        setBaseBranch(def);
      } catch (err) {
        setBranches([]);
        setBranchesError(
          err instanceof ApiError
            ? err.message || `Could not load branches (HTTP ${err.status})`
            : err instanceof Error
              ? err.message
              : String(err),
        );
      }
    })();
  }, [open, api, projectId]);

  async function submit() {
    setError(null);
    if (wtChoice === "new" && !newWtBranch.trim()) {
      setError("New worktree requires branch.");
      return;
    }
    if (wtChoice === "existing" && !existingWtId) {
      setError("Select a worktree.");
      return;
    }
    setSubmitting(true);
    try {
      if (wtChoice === "new") {
        // POST /worktrees already spawns the main `m` agent session with the
        // selected mode + prompt. No additional createSession needed.
        await api.createWorktree({
          projectId,
          branch: newWtBranch.trim(),
          modeId: modeId || "mode-1",
          baseBranch: baseBranch.trim() || undefined,
          prompt: initialPrompt.trim() || undefined,
          useTmux,
        });
      } else {
        await api.createSession({
          worktreeId: existingWtId,
          modeId: modeId || null,
          type: "agent",
          prompt: initialPrompt.trim() || undefined,
          useTmux,
        });
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
          <div className="field-label">Branch</div>
          <Input
            data-autofocus
            aria-label="New worktree branch"
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
                  Couldn’t load branches ({branchesError}). Type a base branch name.
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
        className="field-textarea"
        aria-label="Initial prompt"
        placeholder="Describe what you want the agent to do…"
        rows={4}
        value={initialPrompt}
        onChange={(e) => setInitialPrompt(e.target.value)}
      />
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
