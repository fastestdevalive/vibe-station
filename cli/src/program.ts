import { Command } from "commander";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerDaemonStatus } from "./commands/daemon/status.js";
import { registerDaemonStart } from "./commands/daemon/start.js";
import { registerDaemonStop } from "./commands/daemon/stop.js";
import { registerDaemonRestart } from "./commands/daemon/restart.js";
import { registerProjectAdd } from "./commands/project/add.js";
import { registerProjectCreate } from "./commands/project/create.js";
import { registerProjectRm } from "./commands/project/rm.js";
import { registerProjectLs } from "./commands/project/ls.js";
import { registerProjectInfo } from "./commands/project/info.js";
import { registerWorktreeCreate } from "./commands/worktree/create.js";
import { registerWorktreeRm } from "./commands/worktree/rm.js";
import { registerWorktreeDone } from "./commands/worktree/done.js";
import { registerWorktreeLs } from "./commands/worktree/ls.js";
import { registerWorktreeInfo } from "./commands/worktree/info.js";
import { registerWorktreeRename } from "./commands/worktree/rename.js";
import { registerSessionCreate } from "./commands/session/create.js";
import { registerSessionLs } from "./commands/session/ls.js";
import { registerSessionInfo } from "./commands/session/info.js";
import { registerSessionTranscript } from "./commands/session/transcript.js";
import { registerSessionTerminate } from "./commands/session/terminate.js";
import { registerSessionAttach } from "./commands/session/attach.js";
import { registerSessionRestore } from "./commands/session/restore.js";
import { registerSessionOutput } from "./commands/session/output.js";
import { registerSessionReset } from "./commands/session/reset.js";
import { registerSessionHandoff } from "./commands/session/handoff.js";
import { registerSessionRename } from "./commands/session/rename.js";
import { registerSessionSend } from "./commands/session/send.js";
import { registerSessionStop } from "./commands/session/stop.js";
import { registerModeLs } from "./commands/mode/ls.js";
import { registerModeAdd } from "./commands/mode/add.js";
import { registerModeRm } from "./commands/mode/rm.js";
import { registerOpen } from "./commands/open.js";
import { registerStatus } from "./commands/status.js";
import { registerSummary } from "./commands/summary.js";
import { registerDoctor } from "./commands/doctor.js";

interface PackageJson {
  name: string;
  version: string;
}

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/program.js → ../package.json
  const pkgPath = join(here, "..", "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as PackageJson;
  return pkg.version;
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("vst")
    .description("vibe-station — orchestrate parallel AI coding agents")
    .version(readPackageVersion(), "-v, --version", "print the vst version");

  // Daemon commands
  const daemon = program
    .command("daemon")
    .description("Manage the vibe-station daemon");
  registerDaemonStatus(daemon);
  registerDaemonStart(daemon);
  registerDaemonStop(daemon);
  registerDaemonRestart(daemon);

  // Project commands
  const project = program
    .command("project")
    .description("Manage projects");
  registerProjectAdd(project);
  registerProjectCreate(project);
  registerProjectRm(project);
  registerProjectLs(project);
  registerProjectInfo(project);

  // Worktree commands
  const worktree = program
    .command("worktree")
    .description("Manage worktrees");
  registerWorktreeCreate(worktree);
  registerWorktreeRm(worktree);
  registerWorktreeDone(worktree);
  registerWorktreeLs(worktree);
  registerWorktreeInfo(worktree);
  registerWorktreeRename(worktree);

  // Session commands
  const session = program
    .command("session")
    .description("Manage sessions");
  registerSessionCreate(session);
  registerSessionLs(session);
  registerSessionInfo(session);
  registerSessionTerminate(session);
  registerSessionAttach(session);
  registerSessionRestore(session);
  registerSessionOutput(session);
  registerSessionTranscript(session);
  registerSessionReset(session);
  registerSessionHandoff(session);
  registerSessionRename(session);
  registerSessionSend(session);
  registerSessionStop(session);


  // Mode commands
  const mode = program
    .command("mode")
    .description("Manage modes");
  registerModeLs(mode);
  registerModeAdd(mode);
  registerModeRm(mode);

  // Utility commands
  registerOpen(program);
  registerStatus(program);
  registerSummary(program);
  registerDoctor(program);

  return program;
}
