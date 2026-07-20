import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Mode, SupportedCli } from "@/api/types";
import { ApiError } from "@/api/errors";
import { Dialog } from "./Dialog";
import { Select } from "../ui/Select";
import { NewModeDialog } from "./NewModeDialog";
import { AttachmentPicker } from "../chat/AttachmentPicker";
import { sendJsonFirstTurn } from "@/api/firstTurn";

interface DirectAgentDialogProps {
  open: boolean;
  onClose: () => void;
  api: ApiInstance;
  projectId: string;
  projectName: string;
  onCreated?: () => void;
}

/**
 * Dialog for creating a direct agent session (no worktree).
 * Runs the agent directly in the project directory.
 */
export function DirectAgentDialog({
  open,
  onClose,
  api,
  projectId,
  projectName,
  onCreated,
}: DirectAgentDialogProps) {
  const [modes, setModes] = useState<Mode[]>([]);
  const [modeId, setModeId] = useState("");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [channel, setChannel] = useState<"terminal" | "json">("terminal");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [newModeOpen, setNewModeOpen] = useState(false);
  const [clis, setClis] = useState<SupportedCli[]>([]);

  useEffect(() => {
    if (!open) return;
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

  function reset() {
    setModeId(modes[0]?.id ?? "");
    setInitialPrompt("");
    setChannel("terminal");
    setFiles([]);
    setError(null);
    setSubmitting(false);
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function submit() {
    setError(null);
    if (!modeId) {
      setError("Select a mode.");
      return;
    }

    setSubmitting(true);
    try {
      if (channel === "json") {
        // JSON path: create the session idle (no prompt in the body → daemon does
        // NOT auto-enqueue turn 1), then upload staged files + send the prompt as
        // turn 1 via the chat queue.
        const sess = await api.createDirectSession({
          target: "direct",
          projectId,
          type: "agent",
          modeId,
          channel: "json",
        });
        await sendJsonFirstTurn(api, sess.id, initialPrompt, files);
      } else {
        await api.createDirectSession({
          target: "direct",
          projectId,
          type: "agent",
          modeId,
          prompt: initialPrompt.trim() || undefined,
        });
      }
      onCreated?.();
      handleClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message || `Failed to create session (HTTP ${err.status})`);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError(String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        title={`New Agent — ${projectName}`}
        onClose={handleClose}
        footer={
          <div className="dialog-actions">
            <button type="button" className="btn btn--secondary" onClick={handleClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void submit()}
              disabled={submitting || !modeId}
            >
              {submitting ? "Creating..." : "Start Agent"}
            </button>
          </div>
        }
      >
        <div className="dialog-form">
          <p className="form-hint" style={{ marginBottom: "var(--space-3)" }}>
            Start an agent directly in the project directory (no worktree isolation).
          </p>

          <div className="form-field">
            <label htmlFor="direct-mode">Mode</label>
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              <Select
                id="direct-mode"
                value={modeId}
                onChange={(e) => setModeId(e.target.value)}
                style={{ flex: 1 }}
              >
                {modes.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setNewModeOpen(true)}
              >
                + Mode
              </button>
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="direct-prompt">Initial Prompt (optional)</label>
            <textarea
              id="direct-prompt"
              className="input"
              rows={4}
              placeholder="What would you like the agent to work on?"
              value={initialPrompt}
              onChange={(e) => setInitialPrompt(e.target.value)}
            />
          </div>

          <div className="form-field">
            <label>Channel</label>
            <div role="radiogroup" aria-label="Channel" style={{ display: "flex", gap: "var(--space-4)" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="direct-channel"
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
                  name="direct-channel"
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

          {channel === "json" ? (
            <div className="form-field">
              <label>Attachments <span className="form-optional">(optional)</span></label>
              <AttachmentPicker files={files} onChange={setFiles} />
            </div>
          ) : null}

          {error && <div className="dialog-error">{error}</div>}
        </div>
      </Dialog>

      <NewModeDialog
        open={newModeOpen}
        api={api}
        onClose={() => setNewModeOpen(false)}
        onSaved={async () => {
          // Refresh modes after a new mode is created
          const ms = await api.listModes();
          setModes(ms);
          if (ms.length > 0) {
            // Select the newest mode (last in list)
            setModeId(ms[ms.length - 1]?.id ?? "");
          }
          setNewModeOpen(false);
        }}
      />
    </>
  );
}
