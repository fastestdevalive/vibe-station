import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Mode } from "@/api/types";
import { ApiError } from "@/api/errors";
import { Dialog } from "./Dialog";
import { Select } from "../ui/Select";
import { NewModeDialog } from "./NewModeDialog";

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
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [newModeOpen, setNewModeOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const ms = await api.listModes();
      setModes(ms);
      if (ms[0]) setModeId(ms[0].id);
    })();
  }, [open, api]);

  function reset() {
    setModeId(modes[0]?.id ?? "");
    setInitialPrompt("");
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
      await api.createDirectSession({
        target: "direct",
        projectId,
        type: "agent",
        modeId,
        prompt: initialPrompt.trim() || undefined,
      });
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
