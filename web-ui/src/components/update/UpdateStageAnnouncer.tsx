import { useEffect, useRef, useState } from "react";
import { useUpdateStore } from "@/hooks/useUpdateStore";
import type { InstallStage } from "@/api/types";

const STAGE_TEXT: Record<InstallStage, string> = {
  preflight: "Checking prerequisites",
  downloading: "Downloading update",
  verifying: "Verifying checksum",
  installing: "Installing update",
};

/**
 * Polite live region for install stage changes. Always mounted (from
 * `UpdateChip`) and empty until a stage changes, so a screen reader announces
 * the stage even when the dialog is closed or opened mid-install.
 */
export function UpdateStageAnnouncer() {
  const stage = useUpdateStore((s) => s.status?.install?.stage ?? null);
  const [text, setText] = useState("");
  const last = useRef<InstallStage | null>(null);

  useEffect(() => {
    if (stage && stage !== last.current) {
      last.current = stage;
      setText(STAGE_TEXT[stage]);
    } else if (!stage) {
      last.current = null;
      setText("");
    }
  }, [stage]);

  return (
    <div aria-live="polite" className="update-sr-only">
      {text}
    </div>
  );
}
