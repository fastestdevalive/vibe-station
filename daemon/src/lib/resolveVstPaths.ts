import { access, appendFile, chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const vstHome = () => resolve(homedir(), ".vibe-station");

const SHELL_PATH_MARKER = "added by vibe-station";
const SHELL_PATH_SENTINEL = join(homedir(), ".vibe-station", ".shell-path-installed");

const SHELL_CONFIGS = [
  {
    path: join(homedir(), ".zshrc"),
    line: `\nexport PATH="$HOME/.vibe-station/bin:$PATH"  # ${SHELL_PATH_MARKER}\n`,
  },
  {
    path: join(homedir(), ".bashrc"),
    line: `\nexport PATH="$HOME/.vibe-station/bin:$PATH"  # ${SHELL_PATH_MARKER}\n`,
  },
  // ~/.profile is the POSIX login-shell config sourced by `sh -l` (dash) AFTER
  // /etc/profile resets PATH. Agent harnesses that spawn via `sh -lc` (e.g.
  // claude) run as a POSIX login shell, so ~/.bashrc is never sourced for them.
  // ~/.profile IS sourced and runs after /etc/profile's PATH reset, so prepending
  // here is the correct hook for POSIX-sh agent processes to find `vst`.
  {
    path: join(homedir(), ".profile"),
    line: `\nexport PATH="$HOME/.vibe-station/bin:$PATH"  # ${SHELL_PATH_MARKER}\n`,
  },
  // ~/.zprofile: sourced by zsh login shells (zsh reads ~/.zprofile, not ~/.profile).
  {
    path: join(homedir(), ".zprofile"),
    line: `\nexport PATH="$HOME/.vibe-station/bin:$PATH"  # ${SHELL_PATH_MARKER}\n`,
  },
  {
    path: join(homedir(), ".config", "fish", "config.fish"),
    line: `\nfish_add_path $HOME/.vibe-station/bin  # ${SHELL_PATH_MARKER}\n`,
  },
];

/** Absolute path to the bundled vst CLI binary, or undefined if unavailable. */
export function resolveVstCliBinSource(): string | undefined {
  if (process.env.VST_CLI_BIN) return process.env.VST_CLI_BIN;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "../../main.js");
  return existsSync(candidate) ? candidate : undefined;
}

/** Absolute path to the bundled SKILL.md, or undefined if unavailable. */
export function resolveVstSkillSource(): string | undefined {
  if (process.env.VST_SKILL_PATH) return process.env.VST_SKILL_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "../../../../skill/SKILL.md");
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Write the vst shim to ~/.vibe-station/bin/vst and copy SKILL.md to
 * ~/.vibe-station/skill/vst/SKILL.md. Called once after acquireLock().
 * All failures are logged but never fatal — missing shim/skill degrades
 * gracefully (agents just won't have vst on PATH or the skill in catalog).
 */
export async function setupVstEnvironment(): Promise<void> {
  const binDir = resolve(vstHome(), "bin");
  const shimPath = resolve(binDir, "vst");

  // ── shim ─────────────────────────────────────────────────────────────────
  const src = resolveVstCliBinSource();
  if (src) {
    try {
      await mkdir(binDir, { recursive: true });
      const shimContent = src.endsWith(".js")
        ? `#!/bin/sh\nexec node ${src} "$@"\n`
        : `#!/bin/sh\nexec ${src} "$@"\n`;
      await writeFile(shimPath, shimContent, { encoding: "utf8", mode: 0o755 });
      await chmod(shimPath, 0o755);
    } catch (err) {
      console.warn("[vst] could not write vst shim — agents won't have vst on PATH:", err);
    }
  } else {
    console.warn("[vst] VST_CLI_BIN not set and fallback not found — skipping vst shim");
  }

  // ── skill ─────────────────────────────────────────────────────────────────
  const skillSrc = resolveVstSkillSource();
  if (skillSrc) {
    const skillDest = resolve(vstHome(), "skill", "vst", "SKILL.md");
    try {
      await mkdir(dirname(skillDest), { recursive: true });
      // Atomic: copy to .tmp then rename to avoid partial reads
      const tmp = skillDest + ".tmp";
      await copyFile(skillSrc, tmp);
      await rename(tmp, skillDest);
    } catch (err) {
      console.warn("[vst] could not install vst SKILL.md:", err);
    }
  } else {
    console.warn("[vst] VST_SKILL_PATH not set and fallback not found — skipping skill install");
  }
}

/**
 * On first daemon boot, append PATH lines to ~/.zshrc, ~/.bashrc, and fish config
 * so `vst` is available in any new terminal the user opens.
 * Idempotent: gated by ~/.vibe-station/.shell-path-installed sentinel file.
 */
export async function patchShellConfigs(): Promise<void> {
  // Gate: only run once
  try {
    await access(SHELL_PATH_SENTINEL, constants.F_OK);
    return; // sentinel exists → already patched
  } catch {
    // sentinel absent → proceed
  }

  for (const cfg of SHELL_CONFIGS) {
    try {
      await access(cfg.path, constants.W_OK);
      const content = await readFile(cfg.path, "utf8");
      if (content.includes(SHELL_PATH_MARKER)) continue; // already patched
      await appendFile(cfg.path, cfg.line, "utf8");
    } catch {
      // file not writable or doesn't exist — skip silently
    }
  }

  // Write sentinel so we don't repeat on next boot
  try {
    await mkdir(vstHome(), { recursive: true });
    await writeFile(SHELL_PATH_SENTINEL, new Date().toISOString(), "utf8");
  } catch {
    // best-effort
  }
}
