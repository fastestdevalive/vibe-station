import { resolve } from "node:path";
import { homedir } from "node:os";
import { Command } from "commander";
import { daemonPost } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { die, success } from "../../lib/output.js";

interface CreateProjectResponse {
  project: {
    id: string;
    name: string;
    path: string;
    prefix: string;
    isGit: boolean;
    defaultBranch?: string;
    createdAt: string;
    hidden: boolean;
  };
  worktree?: {
    id: string;
    projectId: string;
    branch: string;
    baseBranch: string;
    baseSha?: string;
    createdAt: string;
    pinnedAt: string | null;
  };
  session?: {
    id: string;
    worktreeId: string | null;
    projectId: string;
    slot: string;
    type: "agent" | "terminal";
    modeId: string | null;
    label: string;
    tmuxName: string;
    state: string;
    createdAt: string;
  };
  warning?: string;
}

interface CreateProjectOptions {
  dir?: string;
  startAgent?: boolean;
  mode?: string;
  prompt?: string;
  worktree?: boolean;
}

export function registerProjectCreate(project: Command): void {
  project
    .command("create <name>")
    .description("Create a new project with git init")
    .option("--dir <path>", "Parent directory (default: settings.defaultProjectsDir)")
    .option("--start-agent", "Start an agent session after creation")
    .option("--mode <id>", "Mode for the agent (required if --start-agent)")
    .option("--prompt <text>", "Initial prompt for the agent")
    .option("--worktree", "Use worktree isolation (creates branch + worktree)")
    .action(async (name: string, opts: CreateProjectOptions) => {
      // Validate options
      if (opts.startAgent && !opts.mode) {
        die("--mode is required when using --start-agent", 1);
      }
      // Without --start-agent there is no agent to give the prompt to, and the body below would
      // drop it silently — the same invisible failure as the --prompt-file bug. Say so instead.
      if (opts.prompt && !opts.startAgent) {
        die("--prompt requires --start-agent (there is no agent to receive it otherwise)", 1);
      }

      await preflight();

      // Resolve dir if provided (relative to cwd)
      let dir: string | undefined;
      if (opts.dir) {
        // Expand ~ to home directory
        if (opts.dir.startsWith("~/")) {
          dir = resolve(homedir(), opts.dir.slice(2));
        } else {
          dir = resolve(opts.dir);
        }
      }

      // Build request body
      const body: {
        name: string;
        dir?: string;
        startAgent?: {
          modeId: string;
          prompt?: string;
          useWorktree?: boolean;
        };
      } = { name };

      if (dir) {
        body.dir = dir;
      }

      if (opts.startAgent && opts.mode) {
        body.startAgent = {
          modeId: opts.mode,
          prompt: opts.prompt,
          useWorktree: opts.worktree,
        };
      }

      const result = await daemonPost<CreateProjectResponse>("/projects/create", body);

      if (!result.ok) {
        if (result.status === 409) {
          die(`${result.error}\nHint: ${result.conflictWith}`, 3);
        }
        die(result.error, result.status === 404 ? 2 : 1);
      }

      const { project: proj, worktree, session, warning } = result.data;

      success(`Created project: ${proj.id}`);
      console.log(`  Path: ${proj.path}`);

      if (warning) {
        console.log(`  Warning: ${warning}`);
      }

      if (worktree) {
        console.log(`  Worktree: ${worktree.id} (branch: ${worktree.branch})`);
      }

      if (session) {
        console.log(`  Session: ${session.id} (${session.state})`);
      }

      // Output the project id for scripting
      console.log(proj.id);
    });
}
