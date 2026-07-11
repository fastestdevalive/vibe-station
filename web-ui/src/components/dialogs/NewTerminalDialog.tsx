import { useEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import { Dialog } from "./Dialog";

interface NewTerminalDialogProps {
  open: boolean;
  onClose: () => void;
  api: ApiInstance;
  /** Context id: worktree id (scope="worktree") or project id (scope="project"). */
  worktreeId: string;
  scope?: "worktree" | "project";
  onCreated?: () => void;
}

/** Create a new terminal session with an editable name (prefilled "Terminal N"). */
export function NewTerminalDialog({
  open,
  onClose,
  api,
  worktreeId,
  scope = "worktree",
  onCreated,
}: NewTerminalDialogProps) {
  const isProject = scope === "project";
  const [name, setName] = useState("");
  const [useTmux, setUseTmux] = useState(true);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Prefill with the daemon's monotonic default ("Terminal N") each open, then
  // select it so the user can either accept or type over it immediately.
  // The next-name endpoint is worktree-only; for project scope let the daemon
  // assign the default name.
  useEffect(() => {
    if (!open || !worktreeId) return;
    if (isProject) {
      setName("");
      requestAnimationFrame(() => inputRef.current?.select());
      return;
    }
    let cancelled = false;
    setName("");
    void (async () => {
      try {
        const suggested = await api.nextTerminalName(worktreeId);
        if (!cancelled) {
          setName(suggested);
          requestAnimationFrame(() => inputRef.current?.select());
        }
      } catch {
        if (!cancelled) setName("Terminal");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, worktreeId, api, isProject]);

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      if (isProject) {
        // Direct terminal — runs in the project base directory (no worktree).
        await api.createDirectSession({
          target: "direct",
          projectId: worktreeId,
          type: "terminal",
          name: name.trim() || undefined,
          useTmux,
        });
      } else {
        await api.createSession({
          worktreeId,
          modeId: null,
          type: "terminal",
          name: name.trim() || undefined,
          useTmux,
        });
      }
      onCreated?.();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title="New terminal"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={() => void submit()} disabled={busy}>
            Create
          </button>
        </>
      }
    >
      <div className="field-label">Name</div>
      <input
        ref={inputRef}
        aria-label="Terminal name"
        placeholder="Terminal"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        style={{
          width: "100%",
          padding: "var(--space-2) var(--space-3)",
          borderRadius: "var(--radius-sm)",
          border: "var(--border-width) solid var(--border-default)",
          background: "var(--bg-input)",
          color: "var(--fg-primary)",
          boxSizing: "border-box",
        }}
      />
      <div style={{ marginTop: "var(--space-4)", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <input
          type="checkbox"
          id="new-terminal-use-tmux-checkbox"
          checked={useTmux}
          onChange={(e) => setUseTmux(e.target.checked)}
        />
        <label htmlFor="new-terminal-use-tmux-checkbox" style={{ cursor: "pointer", userSelect: "none" }}>
          Use tmux (recommended — survives daemon restart, better concurrent device support)
        </label>
      </div>
      {!useTmux ? (
        <div style={{ marginTop: "var(--space-2)", color: "var(--fg-muted)", fontSize: "0.85em" }}>
          Note: without tmux, restarting the daemon will end this terminal and lose its scrollback history.
        </div>
      ) : null}
    </Dialog>
  );
}
