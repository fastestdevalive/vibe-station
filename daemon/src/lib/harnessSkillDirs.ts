import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveVstSkillSource } from "./resolveVstPaths.js";

export const HARNESS_SKILL_RESOLVERS: Array<() => string> = [
  () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "skills"),
  () => join(process.env.GEMINI_CONFIG_DIR ?? join(homedir(), ".gemini"), "skills"),
];

export function resolveHarnessSkillDirs(): string[] {
  return HARNESS_SKILL_RESOLVERS.map((r) => r());
}

/**
 * Read the vst-skill-version marker from the first line of an installed SKILL.md.
 * Returns undefined if the file doesn't exist or has no marker.
 */
async function readInstalledVersion(dest: string): Promise<string | undefined> {
  try {
    const content = await readFile(dest, "utf8");
    const firstLine = content.split("\n")[0] ?? "";
    const m = /^<!-- vst-skill-version: ([^\s]+) -->/.exec(firstLine);
    return m?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Install ~/.vibe-station/skill/vst/SKILL.md into each harness skill dir
 * (~/.claude/skills/vst/SKILL.md, ~/.gemini/skills/vst/SKILL.md).
 * Skips overwrite when the installed version marker matches the source version.
 */
export async function installHarnessSkillDirs(): Promise<void> {
  const skillSrc = resolveVstSkillSource();
  if (!skillSrc) return;

  // Also install into ~/.vibe-station/skill/vst/SKILL.md first (done by
  // setupVstEnvironment, but read from there as the authoritative source).
  const vstSkillDest = resolve(homedir(), ".vibe-station", "skill", "vst", "SKILL.md");
  const srcToRead = existsSync(vstSkillDest) ? vstSkillDest : skillSrc;

  let srcContent: string;
  try {
    srcContent = await readFile(srcToRead, "utf8");
  } catch {
    return;
  }

  // Extract version from frontmatter (e.g. "version: 0.1.0")
  const versionMatch = /^version:\s*([^\s]+)/m.exec(srcContent);
  const version = versionMatch?.[1] ?? "0.0.0";
  const marker = `<!-- vst-skill-version: ${version} -->`;
  const contentWithMarker = `${marker}\n${srcContent}`;

  const dirs = resolveHarnessSkillDirs();
  for (const dir of dirs) {
    const dest = join(dir, "vst", "SKILL.md");
    try {
      const installedVersion = await readInstalledVersion(dest);
      if (installedVersion === version) continue;
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, contentWithMarker, "utf8");
    } catch (err) {
      console.warn(`[vst] could not install skill to ${dest}:`, err);
    }
  }
}
