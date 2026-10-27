import { useMemo } from "react";
import type { ApiInstance } from "@/api";
import { useServerStore } from "@/hooks/useServerStore";
import type { MentionEditorConfig } from "./types";

export function useMentionConfig(api: ApiInstance, sessionId: string): MentionEditorConfig {
  const sessions = useServerStore((s) => s.sessions);

  const { projectId, worktreeId } = useMemo(() => {
    const session = sessions.find((s) => s.id === sessionId);
    return {
      projectId: session?.projectId ?? null,
      worktreeId: session?.worktreeId ?? null,
    };
  }, [sessions, sessionId]);

  return useMemo(
    () => ({
      api,
      projectId,
      worktreeId,
      selfSessionId: sessionId,
    }),
    [api, projectId, worktreeId, sessionId],
  );
}
