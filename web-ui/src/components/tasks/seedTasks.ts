import type { TaskSummary } from "@/api/types";

export const SEED_SCENARIOS = [
  "running+quiet command, subagents, stale",
  "one running command",
  "60-row stress",
  "reduced height (8 rows)",
  "all finished",
] as const;
export type SeedScenario = (typeof SEED_SCENARIOS)[number];

const ago = (now: number, ms: number) => new Date(now - ms).toISOString();

function task(now: number, id: string, over: Partial<TaskSummary>): TaskSummary {
  const t: TaskSummary = {
    id,
    toolId: `tool-${id}`,
    kind: "command",
    label: id,
    state: "running",
    startedAt: ago(now, 60_000),
    lastActivityAt: ago(now, 5_000),
    outputKind: "file",
    outputRev: 1,
    outputPath: `/tmp/claude-1000/dev/tasks/${id}.output`,
    canStop: false,
    ...over,
  };
  if (t.outputKind !== "file") delete t.outputPath;
  return t;
}

/** Dev-simulator task fixtures (Ctrl+Shift+D "Seed tasks"). */
export function buildSeedTasks(scenario: SeedScenario, now = Date.now()): TaskSummary[] {
  switch (scenario) {
    case "one running command":
      return [task(now, "cmd-build", { label: "cargo build --release -p vst-daemon", startedAt: ago(now, 252_000) })];
    case "all finished":
      return [
        task(now, "fin-done", { label: "cargo test", state: "done", endedAt: ago(now, 30_000) }),
        task(now, "fin-failed", { label: "npm run build", state: "failed", reason: "Exit code 1", endedAt: ago(now, 20_000) }),
        task(now, "fin-stopped", { label: "tail -f daemon.log", state: "stopped", endedAt: ago(now, 10_000) }),
      ];
    case "60-row stress":
      return Array.from({ length: 60 }, (_, i) =>
        task(now, `stress-${i}`, {
          label: `sleep ${i + 1} && echo row-${i}`,
          ...(i % 3 === 0
            ? {}
            : { state: "stale" as const, reason: "No end signal from the agent", endedAt: ago(now, i * 1000) }),
        }),
      );
    case "reduced height (8 rows)":
      return Array.from({ length: 8 }, (_, i) =>
        task(now, `row-${i}`, i < 4 ? { label: `watch step ${i}` } : { state: "done", label: `step ${i}`, endedAt: ago(now, 30_000) }),
      );
    default:
      return [
        task(now, "cmd-build", { label: "cargo build --release -p vst-daemon", startedAt: ago(now, 252_000) }),
        task(now, "cmd-quiet", { label: "tail -f daemon.log", startedAt: ago(now, 600_000), lastActivityAt: ago(now, 3 * 60_000) }),
        task(now, "sub-run", {
          kind: "subagent",
          label: "Explore · find ACP callers",
          startedAt: ago(now, 38_000),
          outputKind: "events",
        }),
        task(now, "sub-done", {
          kind: "subagent",
          label: "Review · check ws handlers",
          state: "done",
          startedAt: ago(now, 120_000),
          endedAt: ago(now, 82_000),
          outputKind: "events",
        }),
        task(now, "sub-failed", {
          kind: "subagent",
          label: "Plan · migration",
          state: "failed",
          reason: "Subagent errored",
          endedAt: ago(now, 20_000),
          outputKind: "events",
        }),
        task(now, "cmd-stale", {
          label: "npm run dev",
          state: "stale",
          reason: "No end signal from the agent",
          endedAt: ago(now, 10_000),
        }),
      ];
  }
}
