/**
 * Worktree creation service (instant-draft-agent, Decision 2).
 *
 * Extracts the git-dir creation + `WorktreeRecord` insert from the inline body
 * of `POST /worktrees` (`routes/worktrees.ts`) so BOTH that handler and
 * `POST /sessions/:id/start` (draft promotion into a new worktree) create a
 * worktree through one shared path.
 *
 * The helper does NOT create a session — the caller supplies the sessions that
 * belong in the new worktree via `buildSessions(wtId)`. `POST /worktrees`
 * builds its main agent session there; the draft-promotion route builds an
 * empty array and moves the promoted draft into the worktree afterwards.
 */
import { mutateProject } from "../state/project-store.js";
import { reserveNextWorktreeNum } from "./sessionId.js";
import { worktreePath as getWorktreePath } from "./paths.js";
import { revParse, worktreeAdd } from "./git.js";
import { slugifyPrompt } from "./naming.js";
import { validateBranch, branchExistsInRepo } from "./branchValidator.js";
import type { ProjectRecord, SessionRecord, WorktreeRecord } from "../types.js";

/**
 * Resolve a branch name for a new worktree: an explicit `branch` wins; else
 * derive a slug from `prompt`; else fall back to a `wip/<wtId>` placeholder
 * (with timestamp-suffixed fallback in the pathological case where numbered
 * placeholders are all taken). Moved here from `routes/worktrees.ts` so the
 * draft-promotion route can reuse the exact same derivation for `worktreeChoice:
 * "new"` drafts.
 */
export async function resolveBranchForCreate(opts: {
  repoPath: string;
  prompt?: string;
  wtId: string;
}): Promise<{ branch: string; isPlaceholder: boolean }> {
  const { repoPath, prompt, wtId } = opts;

  if (prompt) {
    const slug = slugifyPrompt(prompt);
    if (slug) {
      const candidates = [slug, ...Array.from({ length: 20 }, (_, i) => `${slug}-${i + 2}`)];
      for (const candidate of candidates) {
        if (!validateBranch(candidate).ok) continue;
        if (!(await branchExistsInRepo(repoPath, candidate))) {
          return { branch: candidate, isPlaceholder: false };
        }
      }
    }
  }

  const placeholder = `wip/${wtId}`;
  if (!(await branchExistsInRepo(repoPath, placeholder))) {
    return { branch: placeholder, isPlaceholder: true };
  }
  for (let n = 2; n < 1000; n++) {
    const candidate = `${placeholder}-${n}`;
    if (!(await branchExistsInRepo(repoPath, candidate))) {
      return { branch: candidate, isPlaceholder: true };
    }
  }
  return { branch: `${placeholder}-${Date.now()}`, isPlaceholder: true };
}

/**
 * Create a git worktree directory + persist its `WorktreeRecord` in the DB.
 *
 * Reserves the worktree id (bumping `nextWorktreeNum`), resolves the branch,
 * captures `baseSha`, runs `git worktree add`, builds the record (with the
 * sessions returned by `buildSessions(wtId)`), and inserts it into the
 * project's `worktrees` array — all in one path.
 *
 * On failure the git worktree directory may already exist (git add succeeded
 * but a later step threw); the caller decides whether to roll back — mirroring
 * the original inline behaviour in `POST /worktrees`, which only rolls back
 * when the record was successfully persisted.
 */
export async function createWorktreeRecord(opts: {
  project: ProjectRecord;
  branch?: string;
  baseBranch: string;
  prompt?: string;
  name?: string;
  buildSessions: (wtId: string) => SessionRecord[];
}): Promise<WorktreeRecord> {
  const { project } = opts;

  // Reserve worktree id: reserve + bump `nextWorktreeNum` atomically inside a
  // single mutateProject call, so the reservation is race-safe and the counter
  // is persisted even if worktree creation fails below (burn-on-failure is
  // intentional — a burned number is never reused).
  let wtNum!: number;
  const freshProject = await mutateProject(project.id, (p) => {
    wtNum = reserveNextWorktreeNum(p);
    return { ...p, nextWorktreeNum: wtNum + 1 };
  });
  const wtId = `${freshProject.prefix}-${wtNum}`;
  const wtPath = getWorktreePath(project.id, wtId);

  // Resolve the branch name now that `wtId` exists (branch-name-optional):
  // explicit input always wins; otherwise derive from the prompt or fall back
  // to a `wip/<wtId>` placeholder.
  const { branch, isPlaceholder: branchIsPlaceholder } = opts.branch
    ? { branch: opts.branch, isPlaceholder: false }
    : await resolveBranchForCreate({ repoPath: project.absolutePath, prompt: opts.prompt, wtId });

  // Capture baseSha before creating the worktree, then git worktree add.
  const baseSha = await revParse(project.absolutePath, opts.baseBranch);
  await worktreeAdd(project.absolutePath, wtPath, branch, opts.baseBranch);

  const sessions = opts.buildSessions(wtId);

  const worktreeRecord: WorktreeRecord = {
    id: wtId,
    ...(opts.name ? { name: opts.name } : {}),
    branch,
    ...(branchIsPlaceholder ? { branchIsPlaceholder: true } : {}),
    baseBranch: opts.baseBranch,
    baseSha,
    createdAt: new Date().toISOString(),
    sortOrder: Date.now(),
    sessions,
  };

  // Persist to manifest (structural change — immediate write).
  await mutateProject(project.id, (p) => ({
    ...p,
    worktrees: [...p.worktrees, worktreeRecord],
  }));

  return worktreeRecord;
}
