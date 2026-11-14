import type { VcsCommitDetailProps } from "./VcsCommitDetail";
import { VcsCommitDetail } from "./VcsCommitDetail";
import { VcsCommitList, type VcsCommitListProps } from "./VcsCommitList";

export interface VcsSidebarProps {
  /** `commit`: the open commit's details and files. `list`: the compact commit list (the commit stays open). */
  level: "commit" | "list";
  list: Omit<VcsCommitListProps, "compact" | "fullPane">;
  detail: VcsCommitDetailProps;
  /** The open commit, marked in the compact list. */
  activeSha: string | null;
}

/** The one list node of the docked sidebar (Decision 7: the level is local UI state in `VcsPanel`). */
export function VcsSidebar({ level, list, detail, activeSha }: VcsSidebarProps) {
  if (level === "commit") return <VcsCommitDetail {...detail} />;
  return <VcsCommitList {...list} compact activeSha={activeSha} />;
}
