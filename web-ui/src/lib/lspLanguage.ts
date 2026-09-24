/**
 * Human-readable display name for an LSP `language` id (e.g. `"go"`,
 * `"typescript"`). Shared by `useLspStatus` (the "not available for X"
 * detail text) and `LspStatusRow` (the bar label + popup language list) so
 * the capitalization rule lives in exactly one place.
 */
export function displayLanguageName(language: string): string {
  if (language === "go") return "Go";
  if (!language) return language;
  return language.charAt(0).toUpperCase() + language.slice(1);
}
