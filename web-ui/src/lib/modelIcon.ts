/**
 * Vendor icon key for a model id, for the composer's model dropdown rows.
 *
 * Model ids are vendor-qualified on some CLIs (`openai/gpt-5`,
 * `opencode/big-pickle`), so the match runs against the segment after the last
 * `/`. Returns an `ModeIcon` key (`claude|deepseek|codex|agy`) or `null` when
 * the vendor is unknown — the caller renders the app's generic fallback glyph.
 *
 * Kept client-side on purpose: the daemon's `AgentPlugin::list_models()` returns
 * plain model strings with no vendor metadata, and this is a cosmetic hint only.
 */
export function modelIconKey(modelId: string | null | undefined): string | null {
  if (!modelId) return null;
  const slash = modelId.lastIndexOf("/");
  const base = (slash >= 0 ? modelId.slice(slash + 1) : modelId).toLowerCase();
  if (!base) return null;
  if (/^(claude|opus|sonnet|haiku)/.test(base)) return "claude";
  if (base.includes("deepseek")) return "deepseek";
  if (/^(gpt|o\d)/.test(base) || base.includes("codex")) return "codex";
  if (/^gemini/.test(base)) return "agy";
  return null;
}
