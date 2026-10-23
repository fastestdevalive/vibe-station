import type { ToolActivity } from "@/api/types";

/** Coarse category, used to pick the card's small activity glyph. */
export type ToolActivityKind =
  | "edit"
  | "read"
  | "run"
  | "search"
  | "web"
  | "agent"
  | "plan"
  | "mcp"
  | "other";

export interface ToolActivityLabel {
  text: string;
  kind: ToolActivityKind;
  /** `text` split for the card: sans verb + (mono) target. `target` is the
   *  file / command detail when the tool call had one. */
  verb: string;
  target?: string;
}

/** `present` = the agent is mid-tool ("Editing x"); `past` = it stopped and is
 *  waiting ("Edited x") — used on Needs-you cards. */
export type ToolActivityTense = "present" | "past";

/**
 * Human label for a session's last tool call ("Editing parseConfig.ts", or
 * "Edited parseConfig.ts" with `tense: "past"`).
 *
 * The daemon already folds every CLI's tool names onto Claude's vocabulary
 * (`vst-agents` `tool_activity.rs`), so this is a pure name -> text table with
 * no per-CLI branching. Unknown names render as "Using <name>".
 */
export function toolActivityLabel(
  tool: ToolActivity | null | undefined,
  tense: ToolActivityTense = "present",
): ToolActivityLabel | null {
  const past = tense === "past";
  const name = tool?.name?.trim();
  if (!name) return null;
  const detail = tool?.detail?.trim() || null;
  // `[present, past]` pairs keep both tenses next to each other.
  const pick = (present: string, pastForm: string) => (past ? pastForm : present);
  const withDetail = (
    verb: string,
    fallback: string,
  ): { text: string; verb: string; target?: string } =>
    detail ? { text: `${verb} ${detail}`, verb, target: detail } : { text: fallback, verb: fallback };
  const plain = (text: string) => ({ text, verb: text });

  switch (name) {
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { kind: "edit", ...withDetail(pick("Editing", "Edited"), pick("Editing files", "Edited files")) };
    case "Write":
      return { kind: "edit", ...withDetail(pick("Writing", "Wrote"), pick("Writing a file", "Wrote a file")) };
    case "Read":
      return { kind: "read", ...withDetail(pick("Reading", "Read"), pick("Reading files", "Read files")) };
    case "Bash":
      return { kind: "run", ...withDetail(pick("Running", "Ran"), pick("Running a command", "Ran a command")) };
    case "Grep":
    case "Glob":
      return { kind: "search", ...plain(pick("Searching", "Searched")) };
    case "WebFetch":
    case "WebSearch":
      return { kind: "web", ...plain(pick("Browsing", "Browsed")) };
    case "Task":
      return { kind: "agent", ...plain(pick("Running a subagent", "Ran a subagent")) };
    case "TodoWrite":
    case "ExitPlanMode":
      return { kind: "plan", ...plain(pick("Planning", "Planned")) };
    default:
      if (name.startsWith("mcp__")) {
        const server = detail ?? name.split("__")[1];
        return {
          kind: "mcp",
          text: `${pick("Calling", "Called")} ${server ? `mcp · ${server}` : "mcp"}`,
          verb: pick("Calling", "Called"),
          target: server ? `mcp · ${server}` : "mcp",
        };
      }
      return { kind: "other", ...plain(`${pick("Using", "Used")} ${name}`) };
  }
}
