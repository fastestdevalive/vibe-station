/**
 * Runs the bundled `project-setup.sh` script against a project directory to
 * make it git-ready: `git init` (if needed), a type-aware `.gitignore`, and
 * an initial commit establishing `main` so `git worktree add ... main` always
 * has a ref to branch off of. Idempotent — a no-op on a repo that already has
 * commits (see the HEAD guard in the script itself).
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitInit, createGitignore } from "./git.js";

const execFile = promisify(execFileCb);

const here = dirname(fileURLToPath(import.meta.url));

// project-setup.sh lives at ../assets/project-setup.sh relative to this file,
// which resolves correctly under both:
//   compiled: dist/daemon/services/ → dist/daemon/assets/project-setup.sh
//   vitest:   src/daemon/services/  → src/daemon/assets/project-setup.sh
function scriptPath(): string {
  return join(here, "..", "assets", "project-setup.sh");
}

/**
 * Make `dir` git-ready: git init + type-aware .gitignore + initial commit
 * establishing `main`. Runs the bundled shell script via execFile (no shell
 * string interpolation). Falls back to the simpler gitInit/createGitignore
 * pair if `bash` isn't available on PATH.
 */
export async function runProjectSetup(dir: string): Promise<void> {
  try {
    await execFile("bash", [scriptPath(), dir]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // bash not available — fall back to the minimal existing behavior.
      await gitInit(dir);
      await createGitignore(dir);
      return;
    }
    throw new Error(`project-setup failed: ${String(err)}`);
  }
}
