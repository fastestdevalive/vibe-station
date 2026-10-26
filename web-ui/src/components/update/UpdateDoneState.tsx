import type { UpdateStatus } from "@/api/types";
import { ManualStepsBlock } from "./ManualStepsBlock";

export function InstalledDoneBody({
  status,
  copiedCommand,
  onCopyCommand,
}: {
  status: UpdateStatus;
  copiedCommand: boolean;
  onCopyCommand: (cmd: string) => void;
}) {
  // ManualStepsBlock lists the updated copies and any targets that were not updated.
  return (
    <div className="update-dialog__body">
      <ManualStepsBlock
        result={status.lastResult!}
        targets={status.targets}
        onCopyCommand={onCopyCommand}
        copiedCommand={copiedCommand}
      />
    </div>
  );
}
