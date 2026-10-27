import type { ApiInstance } from "@/api";

export interface MentionEditorConfig {
  api: ApiInstance;
  projectId: string | null;
  worktreeId: string | null;
  selfSessionId: string | null;
}
