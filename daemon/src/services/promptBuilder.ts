/**
 * 3-layer prompt builder per HIGH-LEVEL-DESIGN.md §4.
 *
 * L1 — base: skill/skill.md (loaded once at daemon boot, cached)
 * L2 — context: project + worktree + mode context
 * L3 — rules: <project>/AGENTS.md or <project>/.vibe-station/rules.md (read at every spawn)
 *
 * Output: { systemPrompt, taskPrompt? }
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectRecord, WorktreeRecord } from "../types.js";
import { worktreePath } from "./paths.js";

const here = dirname(fileURLToPath(import.meta.url));

// agent-system-prompt.md lives at ../assets/agent-system-prompt.md relative to this file,
// which resolves correctly under both:
//   compiled: dist/daemon/services/ → dist/daemon/assets/agent-system-prompt.md
//   vitest:   src/daemon/services/  → src/daemon/assets/agent-system-prompt.md
function assetPath(): string {
  return join(here, "..", "assets", "agent-system-prompt.md");
}

let cachedSkillMd: string | undefined;

async function loadSkillMd(): Promise<string> {
  if (cachedSkillMd !== undefined) return cachedSkillMd;
  try {
    const content = await readFile(assetPath(), "utf8");
    cachedSkillMd = content;
    return content;
  } catch {
    // Fallback if asset not found (should not happen in normal operation)
    cachedSkillMd = "# vibe-station Agent\n\nYou are a vibe-station-managed coding agent.";
    return cachedSkillMd;
  }
}

/** Force-reload the skill.md cache (useful for tests). */
export function _resetSkillCacheForTest(): void {
  cachedSkillMd = undefined;
}

export interface BuildPromptInput {
  project: ProjectRecord;
  worktree: WorktreeRecord;
  modeContext?: string;
  userPrompt?: string;
}

export interface BuildDirectPromptInput {
  project: ProjectRecord;
  modeContext?: string;
  userPrompt?: string;
}

export interface BuiltPrompt {
  systemPrompt: string;
  taskPrompt?: string;
}

/**
 * Build the layered prompt for an agent spawn.
 */
export async function buildPrompt(input: BuildPromptInput): Promise<BuiltPrompt> {
  const { project, worktree, modeContext, userPrompt } = input;

  // L1 — base skill
  const l1 = await loadSkillMd();

  // L2 — project + worktree + mode context
  const wtPath = worktreePath(project.id, worktree.id);
  const l2Lines: string[] = [
    "",
    "## Context",
    "",
    `**Your working directory (worktree):** ${wtPath}`,
    `> This is where you must read and write all files. Do NOT work in the project base directory.`,
    "",
    `**Project:** ${project.id}`,
    `**Project base directory:** ${project.absolutePath} — for reference only; do not edit files here`,
    `**Default branch:** ${project.defaultBranch}`,
    `**Worktree:** ${worktree.id}`,
    `**Branch:** ${worktree.branch}`,
    `**Base branch:** ${worktree.baseBranch} @ ${worktree.baseSha}`,
  ];

  if (worktree.sessions.length > 0) {
    l2Lines.push("", "**Sibling sessions in this worktree:**");
    for (const s of worktree.sessions) {
      l2Lines.push(`- ${s.id} (slot=${s.slot}, type=${s.type}, state=${s.lifecycle.state})`);
    }
  }

  if (modeContext) {
    l2Lines.push("", "## Mode Instructions", "", modeContext);
  }

  const l2 = l2Lines.join("\n");

  // L3 — project-level rules (AGENTS.md or .vibe-station/rules.md)
  const l3 = await readProjectRules(project.absolutePath);

  const systemPrompt = [l1, l2, ...(l3 ? [l3] : [])].join("\n");

  return {
    systemPrompt,
    taskPrompt: userPrompt || undefined,
  };
}

/**
 * Build prompt for a direct session (no worktree).
 * Simpler context — just project, no branch/worktree info.
 */
export async function buildDirectPrompt(input: BuildDirectPromptInput): Promise<BuiltPrompt> {
  const { project, modeContext, userPrompt } = input;

  // L1 — base skill
  const l1 = await loadSkillMd();

  // L2 — project context (no worktree)
  const l2Lines: string[] = [
    "",
    "## Context",
    "",
    `**Your working directory:** ${project.absolutePath}`,
    `> This is a direct session running in the project directory (no worktree isolation).`,
    "",
    `**Project:** ${project.id}`,
  ];

  // Only show defaultBranch for git projects
  if (project.isGit && project.defaultBranch) {
    l2Lines.push(`**Default branch:** ${project.defaultBranch}`);
    l2Lines.push("", "> Note: You are editing files directly in the project directory.");
    l2Lines.push("> Changes will affect the current working tree (no branch isolation).");
  } else {
    l2Lines.push("", "> This is a non-git project. No version control is active.");
  }

  if (modeContext) {
    l2Lines.push("", "## Mode Instructions", "", modeContext);
  }

  const l2 = l2Lines.join("\n");

  // L3 — project-level rules
  const l3 = await readProjectRules(project.absolutePath);

  const systemPrompt = [l1, l2, ...(l3 ? [l3] : [])].join("\n");

  return {
    systemPrompt,
    taskPrompt: userPrompt || undefined,
  };
}

async function readProjectRules(projectPath: string): Promise<string | null> {
  const candidates = [
    join(projectPath, "AGENTS.md"),
    join(projectPath, ".vibe-station", "rules.md"),
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch {
      // file not found — try next
    }
  }
  return null;
}
