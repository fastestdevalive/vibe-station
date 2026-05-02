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
        onChange={() => setTabType("agent")}
      />
      <Radio
        name="tabtype"
        label="Terminal"
        checked={tabType === "terminal"}
        onChange={() => setTabType("terminal")}
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
        </>
      ) : null}
    </Dialog>
  );
}
