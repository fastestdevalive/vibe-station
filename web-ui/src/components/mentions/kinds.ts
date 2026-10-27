import type { ComponentType } from "react";
import { AtSign, Bot, FileText, FolderOpen, GitBranch } from "lucide-react";
import type { MentionKind } from "@/api/types";

export interface MentionKindDef {
  kind: MentionKind;
  section: string;
  singular: string;
  title: string;
  Icon: ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  caption: string;
  /** Plain-text prefix (`@` for files, `@agent:` etc.). */
  plainPrefix: string;
  /** Which mention field follows the prefix in plain text. */
  plainValue: "id" | "label";
}

export const MENTION_KINDS: MentionKindDef[] = [
  {
    kind: "file",
    section: "files",
    singular: "file",
    title: "Files",
    Icon: FileText,
    caption: "this worktree",
    plainPrefix: "@",
    plainValue: "id",
  },
  {
    kind: "agent",
    section: "agents",
    singular: "agent",
    title: "Agents",
    Icon: Bot,
    caption: "this project",
    plainPrefix: "@agent:",
    plainValue: "label",
  },
  {
    kind: "worktree",
    section: "worktrees",
    singular: "worktree",
    title: "Worktrees",
    Icon: GitBranch,
    caption: "this project",
    plainPrefix: "@worktree:",
    plainValue: "label",
  },
  {
    kind: "project",
    section: "projects",
    singular: "project",
    title: "Projects",
    Icon: FolderOpen,
    caption: "all projects",
    plainPrefix: "@project:",
    plainValue: "label",
  },
];

/** Rendered for a kind this client doesn't know (e.g. a newer daemon/tab). */
const GENERIC_KIND_DEF: MentionKindDef = {
  kind: "file",
  section: "",
  singular: "",
  title: "",
  Icon: AtSign,
  caption: "",
  plainPrefix: "@",
  plainValue: "label",
};

/** Never throws: unknown kinds get a generic icon and plain `@label`. */
export function mentionKindDef(kind: string): MentionKindDef {
  return MENTION_KINDS.find((k) => k.kind === kind) ?? GENERIC_KIND_DEF;
}

export function isKnownMentionKind(kind: unknown): kind is MentionKind {
  return typeof kind === "string" && MENTION_KINDS.some((k) => k.kind === kind);
}
