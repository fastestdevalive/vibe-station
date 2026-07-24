import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Mode, SupportedCli } from "@/api/types";
import { Dialog } from "./Dialog";
import { Select } from "../ui/Select";
import { AttachmentPicker } from "../chat/AttachmentPicker";
import { sendJsonFirstTurn } from "@/api/firstTurn";

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
  const [channel, setChannel] = useState<"terminal" | "json">("terminal");
  const [files, setFiles] = useState<File[]>([]);
  const [clis, setClis] = useState<SupportedCli[]>([]);

  useEffect(() => {
    if (!open) return;
    setPrompt("");
    setChannel("terminal");
    setFiles([]);
    void (async () => {
      const [ms, cs] = await Promise.all([api.listModes(), api.getSupportedClis()]);
      setModes(ms);
      setClis(cs);
      if (ms[0]) setModeId(ms[0].id);
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

  const isJson = channel === "json";

  async function submit() {
    if (isJson) {
      // JSON path: create the session idle (no prompt in the body → daemon does
      // NOT auto-enqueue turn 1), then upload staged files + send the prompt as
      // turn 1 via the chat queue. `channel:"json"` forces useTmux=false daemon-side.
      const sess = await api.createSession({
        worktreeId,
        modeId: modeId || null,
        type: "agent",
        channel: "json",
      });
      await sendJsonFirstTurn(api, sess.id, prompt, files);
    } else {
      // KNOWN RACE: unlike the JSON path above, the daemon spawns the CLI
      // with `prompt` baked into argv fire-and-forget as soon as this route
      // handler runs — before this call even returns. The claude
      // UserPromptSubmit hook that reads pending-uploads can fire before the
      // uploadAttachments call below (a separate, later round trip) finishes
      // writing them, so attachments can be missing from turn 1. Fixing this
      // for real needs queue-based delivery for the initial terminal prompt
      // (mirroring how /sessions/:id/chat is "always accepted" for JSON) —
      // /sessions/:id/input 409s if the CLI process isn't registered yet.
      const sess = await api.createSession({
        worktreeId,
        modeId: modeId || null,
        type: "agent",
        prompt: prompt.trim() || undefined,
        useTmux,
      });
      if (files.length > 0) {
        await api.uploadAttachments(sess.id, files);
      }
    }
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
      <div className="field-label" style={{ marginTop: "var(--space-4)" }}>
        Attachments <span style={{ color: "var(--fg-muted)", fontWeight: "normal" }}>(optional)</span>
      </div>
      <AttachmentPicker files={files} onChange={setFiles} />
      <div className="field-label" style={{ marginTop: "var(--space-4)" }}>Channel</div>
      <div role="radiogroup" aria-label="Channel" style={{ display: "flex", gap: "var(--space-4)" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", cursor: "pointer" }}>
          <input
            type="radio"
            name="new-tab-channel"
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
            name="new-tab-channel"
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
      {!isJson ? (
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
      ) : null}
    </Dialog>
  );
}
