import type { LexicalEditor } from "lexical";

/**
 * Test-only seam: Lexical stamps the live editor on its root contenteditable
 * element (`__lexicalEditor`). Tests read it from the DOM instead of the
 * production `SkillEditorHandle` exposing the raw editor.
 */
export function getLexicalEditor(root: Element): LexicalEditor | undefined {
  return (root as Element & { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
}
