import { useMemo } from "react";
import type { MentionItem, SourceResult } from "./mentionRows";
import type { ParsedMentionQuery } from "./mentionQuery";
import type { MentionEditorConfig } from "./types";
import type { MentionKind } from "@/api/types";
import { useFileSearch } from "@/hooks/useFileSearch";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useModesStore } from "@/store/modesStore";
import { cliDisplayName } from "@/lib/cliNames";
import { sessionLabel, worktreeLabel } from "@/lib/sessionLabel";

export function shortenProjectPath(path: string, homeDir?: string): string {
  if (homeDir && path.startsWith(homeDir)) {
    return "~" + path.slice(homeDir.length);
  }
  return path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+)/, "~");
}

export function useFileMentions(
  cfg: MentionEditorConfig,
  parsed: ParsedMentionQuery,
  open: boolean,
): SourceResult {
  const target = cfg.worktreeId
    ? { id: cfg.worktreeId, scope: "worktree" as const }
    : cfg.projectId
    ? { id: cfg.projectId, scope: "project" as const }
    : null;

  const shouldSearch = open && (parsed.scope === null || parsed.scope === "file");
  const targetId = shouldSearch ? target?.id ?? null : null;

  const { files, loading, error, indexing, slowIndexing } = useFileSearch(
    cfg.api,
    targetId,
    parsed.query,
    target?.scope ?? "worktree",
  );

  const items: MentionItem[] = useMemo(() => {
    const list: MentionItem[] = [];
    for (const path of files) {
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x1f\x7f-\x9f]/.test(path)) {
        continue;
      }
      const lastSlash = path.lastIndexOf("/");
      const label = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
      const secondary = lastSlash >= 0 ? path.slice(0, lastSlash) : "";
      list.push({
        kind: "file",
        id: path,
        label,
        secondary,
      });
    }
    return list;
  }, [files]);

  return {
    items,
    loading,
    indexing,
    slowIndexing,
    error,
    unavailable: !target && parsed.scope === "file" ? "Choose a project to search files" : undefined,
  };
}

const EMPTY_ITEMS: MentionItem[] = [];
const EMPTY_RESULT: SourceResult = { items: EMPTY_ITEMS };

export function useAgentMentions(cfg: MentionEditorConfig, open: boolean): SourceResult {
  const sessions = useServerStore((s) => s.sessions);
  const worktrees = useServerStore((s) => s.worktrees);
  const sessionStates = useWorkspaceStore((s) => s.sessionStates);
  const modes = useModesStore((s) => s.modes);

  const items: MentionItem[] = useMemo(() => {
    if (!open) return EMPTY_ITEMS;
    const worktreesById = new Map(worktrees.map((w) => [w.id, w] as const));
    const list: MentionItem[] = [];
    for (const session of sessions) {
      if (session.type !== "agent") continue;
      if (session.archivedAt != null) continue;
      if (session.supersededBy != null) continue;
      if (cfg.projectId !== null && session.projectId !== cfg.projectId) continue;
      if (cfg.selfSessionId !== null && session.id === cfg.selfSessionId) continue;

      const liveState = sessionStates[session.id] ?? session.state;
      if (liveState === "drafting") continue;

      // modes may not be loaded yet on a cold page; the session's own modeIcon snapshot
      // names the CLI for every built-in mode, so fall back to it.
      const cli = (session.modeId ? modes.get(session.modeId)?.cli : undefined) ?? session.modeIcon ?? undefined;
      const cliName = cli ? cliDisplayName(cli) : "";

      // Where the agent lives, relative to the composer: "this worktree" for
      // agents in the composer's own worktree, "direct" for project-level
      // (no worktree) agents, otherwise the other worktree's label.
      let contextLabel = "";
      if (session.worktreeId) {
        if (cfg.worktreeId !== null && session.worktreeId === cfg.worktreeId) {
          contextLabel = "this worktree";
        } else {
          const wt = worktreesById.get(session.worktreeId);
          if (wt) contextLabel = worktreeLabel(wt);
        }
      } else {
        contextLabel = "direct";
      }

      const secondary = cliName
        ? contextLabel
          ? `${cliName} · ${contextLabel}`
          : cliName
        : contextLabel;

      list.push({
        kind: "agent",
        id: session.id,
        label: sessionLabel(session),
        secondary,
        status: liveState,
      });
    }

    // Same-context agents first (the composer's own worktree; or direct agents
    // when the composer is not in a worktree), then recents by createdAt desc.
    const byId = new Map(sessions.map((s) => [s.id, s] as const));
    const sameContext = (id: string): boolean => {
      const sess = byId.get(id);
      if (!sess) return false;
      return cfg.worktreeId !== null
        ? sess.worktreeId === cfg.worktreeId
        : !sess.worktreeId;
    };
    list.sort((a, b) => {
      const sa = sameContext(a.id);
      const sb = sameContext(b.id);
      if (sa !== sb) return sa ? -1 : 1;
      return (byId.get(b.id)?.createdAt ?? "").localeCompare(byId.get(a.id)?.createdAt ?? "");
    });

    return list;
  }, [open, sessions, worktrees, sessionStates, modes, cfg.projectId, cfg.worktreeId, cfg.selfSessionId]);

  return open ? { items } : EMPTY_RESULT;
}

export function useWorktreeMentions(cfg: MentionEditorConfig, open: boolean): SourceResult {
  const worktrees = useServerStore((s) => s.worktrees);

  const items: MentionItem[] = useMemo(() => {
    if (!open) return EMPTY_ITEMS;
    const createdAt = new Map(worktrees.map((w) => [w.id, w.createdAt ?? ""] as const));
    const list: MentionItem[] = [];
    for (const wt of worktrees) {
      if (wt.hiddenAt != null) continue;
      if (cfg.projectId !== null && wt.projectId !== cfg.projectId) continue;

      list.push({
        kind: "worktree",
        id: wt.id,
        label: worktreeLabel(wt),
        secondary: wt.branch,
      });
    }

    list.sort((a, b) => {
      return (createdAt.get(b.id) ?? "").localeCompare(createdAt.get(a.id) ?? "");
    });

    return list;
  }, [open, worktrees, cfg.projectId]);

  return open ? { items } : EMPTY_RESULT;
}

export function useProjectMentions(cfg: MentionEditorConfig, open: boolean): SourceResult {
  const projects = useServerStore((s) => s.projects);

  const items: MentionItem[] = useMemo(() => {
    if (!open) return EMPTY_ITEMS;
    const nonHidden = projects.filter((p) => !p.hidden);

    const sorted = [...nonHidden].sort((a, b) => {
      if (cfg.projectId !== null) {
        if (a.id === cfg.projectId) return -1;
        if (b.id === cfg.projectId) return 1;
      }
      return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
    });

    return sorted.map((p) => ({
      kind: "project" as const,
      id: p.id,
      label: p.name,
      secondary: shortenProjectPath(p.path),
    }));
  }, [projects, cfg.projectId, open]);

  return open ? { items } : EMPTY_RESULT;
}

export function useMentionSources(
  cfg: MentionEditorConfig,
  parsed: ParsedMentionQuery,
  open: boolean,
): Record<MentionKind, SourceResult> {
  const file = useFileMentions(cfg, parsed, open);
  const agent = useAgentMentions(cfg, open);
  const worktree = useWorktreeMentions(cfg, open);
  const project = useProjectMentions(cfg, open);

  return {
    file,
    agent,
    worktree,
    project,
  };
}
