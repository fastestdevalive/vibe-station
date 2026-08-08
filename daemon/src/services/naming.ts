/**
 * Deterministic naming heuristic (F1) — a pure, synchronous slug derived from
 * a creation prompt. No LLM involvement; the CLI already resolves
 * `--prompt`/`--prompt-file` into one string before it reaches the daemon
 * (`resolveFileOrInline`), so this never needs to special-case the
 * prompt-file path.
 *
 * Run once, synchronously, at worktree/session creation whenever
 * `req.body.prompt` is non-empty (Requirement 3). Non-English/non-ASCII
 * prompts and empty/whitespace-only prompts both produce `""` — callers fall
 * back to the existing default label in that case (no i18n handling planned).
 */
const STOPWORDS = new Set([
  "a","an","the","is","are","was","were","be","been","being","to","of","in","on",
  "for","with","and","or","but","as","at","by","from","that","this","these","those",
  "it","its","i","we","you","your","our","please","can","could","would","should",
  "will","just","also","need","needs","want","wants","make","sure","following",
  "described","using","use","via","into","about","if","then","so","not","no","do","does",
]);
const NOISE = new Set(["session", "agent", "worktree", "task", "code", "codebase", "project"]);

export function slugifyPrompt(prompt: string, maxWords = 3, maxLen = 60): string {
  const words = prompt
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ") // strip code fences
    .replace(/https?:\/\/\S+/g, " ") // strip URLs
    .replace(/\S*\/\S+/g, " ") // strip path-shaped tokens entirely (not space-split — avoids "tmp"/"pr" leaking in from /tmp/pr.diff)
    .replace(/[^a-z0-9\s-]/g, " ") // remaining punctuation -> spaces
    .split(/\s+/)
    .filter(Boolean);

  const content = words.filter(
    (w) => w.length > 2 && !STOPWORDS.has(w) && !NOISE.has(w) && !/^\d+$/.test(w),
  );
  if (content.length === 0) return ""; // caller falls back to the existing default label

  const slug = content.slice(0, maxWords).join("-");
  return slug.length > maxLen ? slug.slice(0, maxLen).replace(/-+$/, "") : slug;
}
