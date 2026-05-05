// @ts-nocheck
/**
 * Branch name validation per HIGH-LEVEL-DESIGN.md §5.
 *
 * Rules:
 * - Regex: ^[a-zA-Z0-9][a-zA-Z0-9._/-]*$
 * - No ".." sequences
 * - Max 200 chars
 */
import { branchExists } from "./git.js";

const BRANCH_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._/\-]*$/;
const MAX_LEN = 200;

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Validate a branch name against git-safe rules.
 * Does NOT check whether the branch exists in a repo.
 */
export function validateBranch(name: string): ValidationResult {
  if (!name || name.trim() === "") {
    return { ok: false, reason: "Branch name cannot be empty" };
  }
  if (name.length > MAX_LEN) {
    return { ok: false, reason: `Branch name exceeds ${MAX_LEN} character limit` };
  }
  if (name.includes("..")) {
    return { ok: false, reason: 'Branch name cannot contain ".."' };
  }
  if (!BRANCH_REGEX.test(name)) {
    return {
      ok: false,
      reason:
        'Branch name must start with an alphanumeric character and contain only [a-zA-Z0-9._/-]',
    };
  }
  return { ok: true };
}

/**
 * Returns true if `branch` already exists in the repo at `repoPath`.
 * Rejects with 409 semantics — callers should treat true as a conflict.
 */
export async function branchExistsInRepo(repoPath: string, branch: string): Promise<boolean> {
  return branchExists(repoPath, branch);
}
