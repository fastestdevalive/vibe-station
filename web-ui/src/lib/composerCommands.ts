import type { ComposerCommand } from "@/api/types";

/**
 * Slash-popup grouping (plan Decision 10 / requirement 11).
 *
 * The daemon sets `Command.group` to `"skill"` or `"agent"`; the Composer adds
 * the client-only `"vibe-station"` entries. One rank table drives both the
 * stable sort in `SkillEditor` (so keyboard order matches the rendered order)
 * and the group headers in `SkillPopover`.
 */

export const VIBE_STATION_GROUP = "vibe-station" as const;

/** The client-injected entries. Slash names per OQ4 (`/start-fresh`, `/switch`). */
export const VIBE_STATION_COMMANDS: readonly ComposerCommand[] = [
  {
    name: "start-fresh",
    description: "Start fresh: the agent forgets, choose what carries over",
    group: VIBE_STATION_GROUP,
  },
  {
    name: "switch",
    description: "Switch provider & mode",
    group: VIBE_STATION_GROUP,
  },
];

export const COMMAND_GROUP_LABELS: Record<string, string> = {
  "vibe-station": "Vibe Station",
  skill: "Skills",
  agent: "Agent commands",
};

/** Lower rank renders (and highlights) first. Unknown groups sort with agent. */
export function commandGroupRank(group: ComposerCommand["group"]): number {
  switch (group) {
    case "vibe-station":
      return 0;
    case "skill":
      return 1;
    default:
      return 2;
  }
}

/** Stable-sort by group rank — `Array.prototype.sort` is stable, so catalog
 *  order is preserved inside a group. */
export function sortCommandsByGroup(commands: ComposerCommand[]): ComposerCommand[] {
  return [...commands].sort((a, b) => commandGroupRank(a.group) - commandGroupRank(b.group));
}

/** Inject the Vibe Station entries ahead of the catalog, de-duplicated by name
 *  (a user skill of the same name shadows the injected entry). */
export function withVibeStationCommands(commands: ComposerCommand[]): ComposerCommand[] {
  const taken = new Set(commands.map((c) => c.name));
  return [...VIBE_STATION_COMMANDS.filter((c) => !taken.has(c.name)), ...commands];
}

/** A message that is EXACTLY one of the injected commands — these open a
 *  dialog and never send text. */
export function vibeCommandFromText(text: string): "start-fresh" | "switch" | null {
  const trimmed = text.trim();
  if (trimmed === "/start-fresh") return "start-fresh";
  if (trimmed === "/switch") return "switch";
  return null;
}
