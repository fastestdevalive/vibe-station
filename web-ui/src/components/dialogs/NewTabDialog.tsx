import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Mode } from "@/api/types";
import { Dialog } from "./Dialog";
import { Select } from "../ui/Select";
import { InitialArtifactsField } from "./InitialArtifactsField";

interface NewTabDialogProps {
  open: boolean;
  onClose: () => void;
  api: ApiInstance;
  worktreeId: string;
  onCreated?: () => void;
}

/** Create a new agent session. Terminals use NewTerminalDialog. */
export function NewTabDialog({
  open,
  onClose,
  api,
  worktreeId,
  onCreated,
}: NewTabDialogProps) {
  const [modes, setModes] = useState<Mode[]>([]);
  const [modeId, setModeId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [useTmux, setUseTmux] = useState(true);

  useEffect(() => {
    if (!open) return;
    setPrompt("");
    void (async () => {
      const ms = await api.listModes();
      setModes(ms);
      if (ms[0]) setModeId(ms[0].id);
    })();
  }, [open, api]);

  async function submit() {
    await api.createSession({
      worktreeId,
      modeId: modeId || null,
      type: "agent",
      prompt: prompt.trim() || undefined,
      useTmux,
    });
    onCreated?.();
    onClose();
  }

  return (
    <Dialog
      open={open}
      title="New agent"
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
      <div className="field-label">Mode</div>
      <Select value={modeId} onChange={(e) => setModeId(e.target.value)} aria-label="Mode">
        {modes.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </Select>
      <div className="field-label" style={{ marginTop: "var(--space-4)" }}>
        Prompt <span style={{ color: "var(--fg-muted)", fontWeight: "normal" }}>(optional)</span>
      </div>
      <textarea
        className="field-textarea"
        aria-label="Prompt"
        placeholder="Describe what you want the agent to do…"
        rows={4}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <InitialArtifactsField />
      <div style={{ marginTop: "var(--space-4)", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <input
          type="checkbox"
          id="new-agent-use-tmux-checkbox"
          checked={useTmux}
          onChange={(e) => setUseTmux(e.target.checked)}
        />
        <label htmlFor="new-agent-use-tmux-checkbox" style={{ cursor: "pointer", userSelect: "none" }}>
          Use tmux (recommended — survives daemon restart, better concurrent device support)
        </label>
      </div>
    </Dialog>
  );
}
