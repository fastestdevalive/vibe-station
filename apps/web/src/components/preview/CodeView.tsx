import { useEffect, useState } from "react";
import { createHighlighter, type BundledLanguage, type Highlighter } from "shiki";

interface CodeViewProps {
  code: string;
  language: BundledLanguage | string;
  themeMode: "dark" | "light";
}

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark", "github-light"],
      langs: ["typescript", "javascript", "tsx", "jsx", "json", "markdown", "css", "html", "go"],
    });
  }
  return highlighterPromise;
}

function themeId(mode: "dark" | "light") {
  return mode === "dark" ? "github-dark" : "github-light";
}

export function CodeView({ code, language, themeMode }: CodeViewProps) {
  const [html, setHtml] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const hi = await getHighlighter();
      const langs = hi.getLoadedLanguages();
      const lang = langs.includes(language as BundledLanguage)
        ? (language as BundledLanguage)
        : "typescript";
      const out = hi.codeToHtml(code, {
        lang,
        theme: themeId(themeMode),
      });
      if (!cancelled) setHtml(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [code, language, themeMode]);

  return (
    <div
      className="shiki-host"
      style={{ fontSize: "var(--font-size-sm)" }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
