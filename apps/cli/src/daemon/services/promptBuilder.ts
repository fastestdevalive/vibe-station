/**
 * 3-layer prompt builder per HIGH-LEVEL-DESIGN.md §4.
 *
 * L1 — base: skill/skill.md (loaded once at daemon boot, cached)
 * L2 — context: project + worktree + mode context
 * L3 — rules: <project>/AGENTS.md or <project>/.viberun/rules.md (read at every spawn)
 *
 * Output: { systemPrompt, taskPrompt? }
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectRecord, WorktreeRecord } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));

// Skill.md is at skill/skill.md relative to the repo root.
// From dist/daemon/services/, navigate up to find it.
// Fallback chain for different run contexts.
function skillMdCandidates(): string[] {
  return [
    // From compiled dist/daemon/services/promptBuilder.js:
    //   → ../../../../skill/skill.md
    join(here, "..", "..", "..", "..", "skill", "skill.md"),
    // From src/daemon/services/promptBuilder.ts (vitest):
    //   → ../../../../../skill/skill.md
    join(here, "..", "..", "..", "..", "..", "skill", "skill.md"),
  ];
}

let cachedSkillMd: string | undefined;

async function loadSkillMd(): Promise<string> {
  if (cachedSkillMd !== undefined) return cachedSkillMd;
  for (const candidate of skillMdCandidates()) {
    try {
      const content = await readFile(candidate, "utf8");
      cachedSkillMd = content;
      return content;
    } catch {
      // try next
    }
  }
  // Fallback if file not found
  cachedSkillMd = "# viberun-ide Agent\n\nYou are a viberun-ide-managed coding agent.";
  return cachedSkillMd;
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
  const l2Lines: string[] = [
    "",
    "## Context",
    "",
    `**Project:** ${project.id} (${project.absolutePath})`,
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

  // L3 — project-level rules (AGENTS.md or .viberun/rules.md)
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
    join(projectPath, ".viberun", "rules.md"),
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
