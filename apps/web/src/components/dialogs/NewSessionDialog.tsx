import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Mode, Worktree } from "@/api/types";
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
  const [baseBranch, setBaseBranch] = useState("main");
  const [modes, setModes] = useState<Mode[]>([]);
  const [modeId, setModeId] = useState("");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
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
  }, [open, api, projectId]);

  async function submit() {
    setError(null);
    if (wtChoice === "new") {
      if (!newWtBranch.trim()) {
        setError("New worktree requires branch.");
        return;
      }
      // POST /worktrees already spawns the main `m` agent session with the
      // selected mode + prompt. No additional createSession needed.
      await api.createWorktree({
        projectId,
        branch: newWtBranch.trim(),
        modeId: modeId || "mode-1",
        baseBranch: baseBranch.trim() || undefined,
        prompt: initialPrompt.trim() || undefined,
      });
    } else {
      if (!existingWtId) {
        setError("Select a worktree.");
        return;
      }
      await api.createSession({
        worktreeId: existingWtId,
        modeId: modeId || null,
        type: "agent",
        initialPrompt: initialPrompt.trim() || undefined,
      });
    }
    onCreated?.();
    onClose();
  }

  return (
    <>
    <Dialog
      open={open}
      title={`New session — ${projectName}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={() => void submit()}>
            Create
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
            aria-label="New worktree branch"
            value={newWtBranch}
            onChange={(e) => setNewWtBranch(e.target.value)}
          />
          <div className="field-label">Base branch</div>
          <Input
            aria-label="Base branch"
            value={baseBranch}
            onChange={(e) => setBaseBranch(e.target.value)}
          />
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
