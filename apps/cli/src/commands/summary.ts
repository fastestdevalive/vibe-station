import { Command } from "commander";
import chalk from "chalk";
import { daemonGet } from "../lib/daemon-client.js";
import { preflight } from "../lib/preflight.js";
import { getVSTProject } from "../lib/env.js";
import { printJson, die } from "../lib/output.js";

interface DaemonWorktree {
  id: string;
  projectId: string;
  branch: string;
}

interface DaemonSession {
  id: string;
  worktreeId: string;
  slot: string;
  type: string;
  state: string;
  createdAt?: string;
}

export interface SummaryJsonWorktree {
  id: string;
  branch: string;
  sessions: Array<{
    id: string;
    slot: string;
    state: string;
    type: string;
    lastTransitionAt?: string;
  }>;
}

export interface SummaryJson {
  generatedAt: string;
  worktrees: SummaryJsonWorktree[];
}

/** Merge sessions onto listed worktrees (test seam). */
export function groupSessionsByWorktree(
  worktrees: DaemonWorktree[],
  sessions: DaemonSession[],
): Map<string, DaemonSession[]> {
  const m = new Map<string, DaemonSession[]>();
  for (const w of worktrees) {
    m.set(w.id, []);
  }
  for (const s of sessions) {
    if (!m.has(s.worktreeId)) continue;
    m.get(s.worktreeId)!.push(s);
  }
  return m;
}

function glyphForState(state: string): string {
  switch (state) {
    case "working":
      return chalk.green("●");
    case "idle":
      return chalk.dim("○");
    case "not_started":
      return chalk.yellow("◐");
    case "done":
      return chalk.blue("✓");
    case "exited":
      return chalk.red("×");
    default:
      return chalk.dim("·");
  }
}

export function registerSummary(program: Command): void {
  program
    .command("summary")
    .description("Summarize sessions grouped by worktree")
    .option("--json", "Output JSON snapshot")
    .option("--project <id>", "Filter worktrees by project id")
    .action(async (opts: { json?: boolean; project?: string }) => {
      await preflight();

      const wtRes = await daemonGet<DaemonWorktree[]>("/worktrees");
      if (!wtRes.ok) die(wtRes.error ?? "Failed to list worktrees", 1);

      const sessRes = await daemonGet<DaemonSession[]>("/sessions");
      if (!sessRes.ok) die(sessRes.error ?? "Failed to list sessions", 1);

      const filterProject = opts.project ?? getVSTProject();

      let worktrees = wtRes.data;
      if (filterProject) {
        worktrees = worktrees.filter((w) => w.projectId === filterProject);
      }

      const grouped = groupSessionsByWorktree(worktrees, sessRes.data);

      const jsonPayload: SummaryJson = {
        generatedAt: new Date().toISOString(),
        worktrees: worktrees.map((w) => ({
          id: w.id,
          branch: w.branch,
          sessions: (grouped.get(w.id) ?? []).map((s) => ({
            id: s.id,
            slot: s.slot,
            state: s.state,
            type: s.type,
            lastTransitionAt: s.createdAt,
          })),
        })),
      };

      if (opts.json) {
        printJson(jsonPayload);
        return;
      }

      if (jsonPayload.worktrees.length === 0) {
        console.log("No worktrees match filter.");
        return;
      }

      for (const w of jsonPayload.worktrees) {
        const glyphs = w.sessions.map((s) => glyphForState(s.state)).join("");
        console.log(
          `${w.id} [${w.branch}] · ${w.sessions.length} sessions · ${glyphs || chalk.dim("(none)")}`,
        );
      }
    });
}
