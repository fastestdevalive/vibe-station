import type { TaskSummary } from "@/api/types";

/** Test fixture builder for `TaskSummary`. */
export function mkTask(over: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "t1",
    toolId: "tool-t1",
    kind: "command",
    label: "cargo build --release",
    state: "running",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    lastActivityAt: new Date(Date.now() - 5_000).toISOString(),
    outputKind: "file",
    outputRev: 1,
    outputPath: "/tmp/claude-1000/p/tasks/t1.output",
    canStop: false,
    ...over,
  };
}

export const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
