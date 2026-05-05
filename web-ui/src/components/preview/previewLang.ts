import { languageForFilePath } from "./codeHighlight";

/** Map highlight.js / path → Shiki grammar id */
export function pickShikiLang(filePath: string | undefined, hljsLang: string | undefined): string {
  const ext = filePath?.includes(".") ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : "";
  if (ext === ".tsx") return "tsx";
  if (ext === ".jsx") return "jsx";
  if (hljsLang === "xml") return "html";
  if (hljsLang === "bash") return "shellscript";

  const map: Record<string, string> = {
    javascript: "javascript",
    typescript: "typescript",
    python: "python",
    json: "json",
    css: "css",
    yaml: "yaml",
    rust: "rust",
    go: "go",
    kotlin: "kotlin",
    groovy: "groovy",
  };
  return map[hljsLang ?? ""] ?? "plaintext";
}

export function shikiLangForFilePath(path: string): string {
  return pickShikiLang(path, languageForFilePath(path));
}
