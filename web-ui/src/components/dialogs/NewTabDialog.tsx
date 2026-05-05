import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Mode } from "@/api/types";
import { Dialog } from "./Dialog";
import { Radio } from "../ui/Radio";
import { Select } from "../ui/Select";

interface NewTabDialogProps {
  open: boolean;
  onClose: () => void;
  api: ApiInstance;
  worktreeId: string;
  onCreated?: () => void;
}

export function NewTabDialog({
  open,
  onClose,
  api,
  worktreeId,
  onCreated,
}: NewTabDialogProps) {
  const [tabType, setTabType] = useState<"agent" | "terminal">("agent");
  const [modes, setModes] = useState<Mode[]>([]);
  const [modeId, setModeId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [useTmux, setUseTmux] = useState(true);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const ms = await api.listModes();
      setModes(ms);
      if (ms[0]) setModeId(ms[0].id);
    })();
  }, [open, api]);

  async function submit() {
    await api.createSession({
      worktreeId,
      modeId: tabType === "agent" ? modeId || null : null,
      type: tabType === "agent" ? "agent" : "terminal",
      prompt: tabType === "agent" ? prompt.trim() || undefined : undefined,
      useTmux,
    });
    onCreated?.();
    onClose();
  }

  return (
    <Dialog
      open={open}
      title="New tab"
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
      <div className="field-label">Type</div>
      <Radio
        name="tabtype"
        label="Agent"
        checked={tabType === "agent"}
        onChange={() => {
          setTabType("agent");
          setPrompt("");
        }}
      />
      <Radio
        name="tabtype"
        label="Terminal"
        checked={tabType === "terminal"}
        onChange={() => {
          setTabType("terminal");
          setPrompt("");
        }}
      />
      {tabType === "agent" ? (
        <>
          <div className="field-label">Mode</div>
          <Select value={modeId} onChange={(e) => setModeId(e.target.value)} aria-label="Mode">
            {modes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
          <div className="field-label" style={{ marginTop: "var(--space-4)" }}>Prompt <span style={{ color: "var(--fg-muted)", fontWeight: "normal" }}>(optional)</span></div>
          <textarea
            className="field-textarea"
            aria-label="Prompt"
            placeholder="Describe what you want the agent to do…"
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </>
      ) : null}
      <div style={{ marginTop: "var(--space-4)", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <input
          type="checkbox"
          id="new-tab-use-tmux-checkbox"
          checked={useTmux}
          onChange={(e) => setUseTmux(e.target.checked)}
        />
        <label htmlFor="new-tab-use-tmux-checkbox" style={{ cursor: "pointer", userSelect: "none" }}>
          Use tmux (recommended — survives daemon restart, better concurrent device support)
        </label>
      </div>
      {!useTmux && tabType === "terminal" ? (
        <div style={{ marginTop: "var(--space-2)", color: "var(--fg-muted)", fontSize: "0.85em" }}>
          Note: without tmux, restarting the daemon will end this terminal and lose its scrollback history.
        </div>
      ) : null}
    </Dialog>
  );
}
