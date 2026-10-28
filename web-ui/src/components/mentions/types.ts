import type { ApiInstance } from "@/api";
import type { MentionKind } from "@/api/types";

export interface MentionEditorConfig {
  api: ApiInstance;
  projectId: string | null;
  worktreeId: string | null;
  selfSessionId: string | null;
  /** Restrict the popover to these kinds (the comment box allows files only). Omitted = every kind. */
  kinds?: readonly MentionKind[];
}
