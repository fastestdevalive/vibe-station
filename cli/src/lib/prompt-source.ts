import { readFileSync } from "fs";
import { die, warn } from "./output.js";

/**
 * Resolve a text value supplied either inline or via a file path.
 *
 * Used by the `--prompt` / `--prompt-file` and `--context` / `--context-file` flag pairs.
 *
 * Reading the file is deliberately fail-loud: a prompt the caller explicitly asked for must never
 * be silently dropped. Dropping it produces an agent that spawns fine and then sits with no task —
 * a failure that is invisible at the CLI (exit 0) and indistinguishable, at the daemon, from a
 * deliberately prompt-less session. That silence is what made the original `--prompt-file` bug
 * survive so long.
 *
 * Mutual exclusion of the two flags is enforced declaratively by commander via
 * `Option.conflicts()` at each call site, so it is not re-checked here.
 *
 * @param inline    value from the inline flag (e.g. `--prompt`)
 * @param filePath  value from the file flag (e.g. `--prompt-file`)
 * @param fileFlag  the file flag's name, for error messages (e.g. `--prompt-file`)
 * @returns the resolved text, or undefined when neither flag was supplied
 */
export function resolveFileOrInline(
  inline: string | undefined,
  filePath: string | undefined,
  fileFlag: string
): string | undefined {
  if (!filePath) return inline;

  let contents: string;
  try {
    contents = readFileSync(filePath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return die(`Cannot read ${fileFlag} ${filePath}: ${message}`, 1);
  }

  // An empty file yields an agent with no task — the exact symptom this flag's bug produced.
  // Warn rather than fail: it is unambiguously not what the caller intended, but it is their call.
  if (contents.trim() === "") {
    warn(`${fileFlag} ${filePath} is empty — the agent will start with no task.`);
  }

  return contents;
}
