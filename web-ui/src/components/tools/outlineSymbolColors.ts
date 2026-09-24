import type { BuiltinTheme, BundledLanguage } from "shiki";
import type { OutlineSymbol } from "@/lib/lspApi";
import { getShikiHighlighter, setActiveTheme } from "../preview/shikiHighlighter";

/** Key scheme: symbol colors are looked up by declaration line + name, not
 *  by the outline's tree-position symId — the color is a property of what
 *  Shiki tokenized at that exact source location, independent of where the
 *  symbol sits in the outline tree. */
function colorKey(line: number, name: string): string {
  return `${line}:${name}`;
}

function flattenSymbols(symbols: OutlineSymbol[], out: OutlineSymbol[] = []): OutlineSymbol[] {
  for (const sym of symbols) {
    out.push(sym);
    if (sym.children && sym.children.length > 0) flattenSymbols(sym.children, out);
  }
  return out;
}

/**
 * Resolves each symbol's declaration-line color by tokenizing the real
 * source with the SAME Shiki highlighter/theme/language the code viewer
 * uses (`highlightDocumentLines` in shikiHighlighter.ts) — this makes the
 * outline's text color match the file preview exactly (same theme, same
 * language grammar), rather than an approximated fixed palette.
 *
 * A symbol whose token can't be located (name not found on its declared
 * line, e.g. multi-line signatures or an unsupported language) is simply
 * absent from the returned map — callers fall back to a static per-kind
 * color in that case.
 */
export async function resolveSymbolColors(
  code: string,
  lang: string,
  shikiThemeId: string,
  symbols: OutlineSymbol[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const flat = flattenSymbols(symbols);
  if (flat.length === 0) return result;

  await setActiveTheme(shikiThemeId);
  const highlighter = await getShikiHighlighter();

  // `lang`/`shikiThemeId` come from the app's own runtime-resolved file
  // language / theme registry (see previewLang.ts, theme/registry.ts) — both
  // already validated against Shiki's bundled lists elsewhere (same pattern
  // shikiHighlighter.ts's `setActiveTheme` uses for `loadTheme`), so casting
  // past the literal-union types here is safe, not a type-safety hole.
  let tokenLines: { content: string; offset: number; color?: string }[][];
  try {
    tokenLines = highlighter.codeToTokensBase(code, {
      lang: lang as BundledLanguage,
      theme: shikiThemeId as BuiltinTheme,
    });
  } catch {
    try {
      tokenLines = highlighter.codeToTokensBase(code, {
        lang: "plaintext",
        theme: shikiThemeId as BuiltinTheme,
      });
    } catch {
      return result;
    }
  }

  for (const sym of flat) {
    const line = tokenLines[sym.line];
    if (!line) continue;

    // Shiki's ThemedToken.offset is FILE-wide (from the start of the whole
    // document), but the LSP's `sym.character` is LINE-relative. Shiki always
    // emits at least one token per non-empty line starting at column 0, so the
    // first token's offset is this line's file-wide start — subtract it to make
    // the comparison line-relative. Otherwise an exact-position match only ever
    // succeeds for symbols on line 0, silently falling through to the text
    // fallback below (which picks the WRONG token when a name appears twice on
    // the same line, e.g. `Self::new()` inside `fn new()`).
    const lineStartOffset = line[0]?.offset ?? 0;

    // Prefer the token starting exactly at the symbol's reported character
    // (LSP selectionRange typically points at the identifier's own start).
    let match = line.find(
      (t) => t.offset - lineStartOffset === sym.character && t.content === sym.name
    );
    // Fall back to the first token on the line with matching text, in case
    // the offset convention differs for this language server, or the line has
    // no tokens (empty line).
    if (!match) match = line.find((t) => t.content === sym.name);
    if (match?.color) {
      result.set(colorKey(sym.line, sym.name), match.color);
    }
  }

  return result;
}

export { colorKey };
