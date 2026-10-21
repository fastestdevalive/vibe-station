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

/**
 * Human label for a session's last tool call ("Editing parseConfig.ts").
 *
 * The daemon already folds every CLI's tool names onto Claude's vocabulary
 * (`vst-agents` `tool_activity.rs`), so this is a pure name -> text table with
 * no per-CLI branching. Unknown names render as "Using <name>".
 */
export function toolActivityLabel(tool: ToolActivity | null | undefined): ToolActivityLabel | null {
  const name = tool?.name?.trim();
  if (!name) return null;
  const detail = tool?.detail?.trim() || null;
  const withDetail = (verb: string, fallback: string): { text: string; verb: string; target?: string } =>
    detail ? { text: `${verb} ${detail}`, verb, target: detail } : { text: fallback, verb: fallback };
  const plain = (text: string) => ({ text, verb: text });

  switch (name) {
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { kind: "edit", ...withDetail("Editing", "Editing files") };
    case "Write":
      return { kind: "edit", ...withDetail("Writing", "Writing a file") };
    case "Read":
      return { kind: "read", ...withDetail("Reading", "Reading files") };
    case "Bash":
      return { kind: "run", ...withDetail("Running", "Running a command") };
    case "Grep":
    case "Glob":
      return { kind: "search", ...plain("Searching") };
    case "WebFetch":
    case "WebSearch":
      return { kind: "web", ...plain("Browsing") };
    case "Task":
      return { kind: "agent", ...plain("Running a subagent") };
    case "TodoWrite":
    case "ExitPlanMode":
      return { kind: "plan", ...plain("Planning") };
    default:
      if (name.startsWith("mcp__")) {
        const server = detail ?? name.split("__")[1];
        return {
          kind: "mcp",
          text: server ? `Calling mcp · ${server}` : "Calling mcp",
          verb: "Calling",
          target: server ? `mcp · ${server}` : "mcp",
        };
      }
      return { kind: "other", ...plain(`Using ${name}`) };
  }
}
