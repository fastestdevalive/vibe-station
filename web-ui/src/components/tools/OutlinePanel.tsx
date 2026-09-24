import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Search, Code, Box, Layers, Component, List, Package, Hash, Tag, FileCode } from "lucide-react";
import type { FileScope } from "@/api/types";
import {
  getExternalFile,
  getOutline,
  getWorkspaceFile,
  isLspNotReady,
  type LspFileRef,
  type OutlineSymbol,
} from "@/lib/lspApi";
import { useWorkspaceStore } from "@/hooks/useStore";
import { usePreviewedPath } from "@/hooks/usePreviewedPath";
import { useTheme } from "@/hooks/useTheme";
import { themeById } from "@/theme/registry";
import { languageForFilePath } from "../preview/codeHighlight";
import { pickShikiLang } from "../preview/previewLang";
import { colorKey, resolveSymbolColors } from "./outlineSymbolColors";

export interface OutlinePanelProps {
  api: unknown;
  worktreeId: string | null;
  scope?: FileScope;
}

/**
 * Finds the innermost OutlineSymbol whose [line, endLine] range contains targetLine
 * (depth-first descent into children).
 */
export function findInnermostSymbol(
  symbols: OutlineSymbol[],
  targetLine: number
): OutlineSymbol | null {
  for (const sym of symbols) {
    if (targetLine >= sym.line && targetLine <= sym.endLine) {
      if (sym.children && sym.children.length > 0) {
        const childMatch = findInnermostSymbol(sym.children, targetLine);
        if (childMatch) {
          return childMatch;
        }
      }
      return sym;
    }
  }
  return null;
}

/**
 * Finds the topmost visible [data-line] inside a scroll container.
 */
export function findTopmostVisibleLine(container: HTMLElement): number | null {
  const containerRect = container.getBoundingClientRect();
  const lineEls = container.querySelectorAll<HTMLElement>("[data-line]");
  // Try getBoundingClientRect first
  for (let i = 0; i < lineEls.length; i++) {
    const el = lineEls[i];
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.bottom >= containerRect.top && rect.top <= containerRect.bottom) {
      const l = parseInt(el.getAttribute("data-line") ?? "", 10);
      if (!isNaN(l)) return l;
    }
  }
  // Fallback for JSDOM or scroll offset calculation:
  const scrollTop = container.scrollTop;
  for (let i = 0; i < lineEls.length; i++) {
    const el = lineEls[i];
    if (!el) continue;
    const top = el.offsetTop;
    const height = el.offsetHeight || 18;
    if (top + height >= scrollTop) {
      const l = parseInt(el.getAttribute("data-line") ?? "", 10);
      if (!isNaN(l)) return l;
    }
  }
  const firstEl = lineEls[0];
  if (firstEl) {
    const l = parseInt(firstEl.getAttribute("data-line") ?? "", 10);
    if (!isNaN(l)) return l;
  }
  return null;
}

function filterSymbols(symbols: OutlineSymbol[], query: string): OutlineSymbol[] {
  if (!query.trim()) return symbols;
  const q = query.toLowerCase().trim();

  const result: OutlineSymbol[] = [];
  for (const sym of symbols) {
    const nameMatches = sym.name.toLowerCase().includes(q);
    const filteredChildren = sym.children ? filterSymbols(sym.children, q) : [];
    if (nameMatches || filteredChildren.length > 0) {
      result.push({
        ...sym,
        children: filteredChildren,
      });
    }
  }
  return result;
}

/**
 * Groups an LSP symbol kind into the same coloring buckets the code
 * viewer's hljs theme uses (function / type / namespace / default-untinted)
 * — see the `.outline-panel__symbol-*--<kind>` rules in workspace.css.
 */
function getSymbolKindClass(kind: string): string | null {
  switch (kind) {
    case "function":
    case "method":
    case "constructor":
      return "function";
    case "class":
    case "interface":
    case "struct":
    case "enum":
      return "type";
    case "module":
    case "namespace":
    case "package":
      return "namespace";
    default:
      return null;
  }
}

function getSymbolIcon(kind: string, kindClass: string | null, resolvedColor: string | undefined) {
  const iconClassName = `outline-panel__symbol-icon${kindClass ? ` outline-panel__symbol-icon--${kindClass}` : ""}`;
  // Inline style (when the code viewer's own tokenizer resolved an exact
  // color for this symbol) always wins over the static per-kind CSS class —
  // no specificity juggling needed. Falls back to the class's color when
  // resolution failed (see the color-resolution effect's catch branch).
  const style = resolvedColor ? { color: resolvedColor } : undefined;
  switch (kind) {
    case "function":
    case "method":
    case "constructor":
      return <Code size={13} className={iconClassName} style={style} aria-hidden />;
    case "class":
      return <Box size={13} className={iconClassName} style={style} aria-hidden />;
    case "interface":
      return <Layers size={13} className={iconClassName} style={style} aria-hidden />;
    case "struct":
      return <Component size={13} className={iconClassName} style={style} aria-hidden />;
    case "enum":
      return <List size={13} className={iconClassName} style={style} aria-hidden />;
    case "module":
    case "namespace":
    case "package":
      return <Package size={13} className={iconClassName} style={style} aria-hidden />;
    case "variable":
    case "constant":
    case "property":
    case "field":
      return <Hash size={13} className={iconClassName} style={style} aria-hidden />;
    default:
      return <Tag size={13} className={iconClassName} style={style} aria-hidden />;
  }
}

/**
 * Symbol id scheme shared by the default-collapse pass and the tree
 * renderer — must stay identical between the two or a default-collapsed
 * function would "reset" to expanded the moment the id it was keyed under
 * doesn't match what `renderTree` computes for the same node.
 */
function buildSymId(parentId: string, sym: OutlineSymbol, idx: number): string {
  return `${parentId}/${sym.name}-${sym.kind}-${sym.line}-${idx}`;
}

/**
 * Functions/methods/constructors that themselves contain nested symbols
 * (closures, locals) default to collapsed, so the outline reads as a flat,
 * quickly-scannable list of function names — expanding one is an explicit
 * per-row action. Containers (classes, modules, ...) stay expanded so their
 * member list is visible without an extra click.
 */
/**
 * A "leaf" function: function/method/constructor kind, has children (so
 * there's actually something to collapse), and none of those children are
 * themselves function-kind. A function that CONTAINS nested functions
 * (closures, local defs) stays expanded by default — collapsing it would
 * hide the very nested functions you'd want to iterate over; only the
 * bottom-of-the-tree functions (whose children are just locals/params, or
 * no children at all) collapse.
 */
function isLeafFunction(sym: OutlineSymbol): boolean {
  if (getSymbolKindClass(sym.kind) !== "function") return false;
  if (!sym.children || sym.children.length === 0) return false;
  return !sym.children.some((child) => getSymbolKindClass(child.kind) === "function");
}

function computeDefaultCollapsed(
  items: OutlineSymbol[],
  parentId = "",
  acc: Record<string, boolean> = {}
): Record<string, boolean> {
  items.forEach((sym, idx) => {
    const symId = buildSymId(parentId, sym, idx);
    const hasChildren = Boolean(sym.children && sym.children.length > 0);
    if (hasChildren) {
      if (isLeafFunction(sym)) {
        acc[symId] = true;
      }
      computeDefaultCollapsed(sym.children!, symId, acc);
    }
  });
  return acc;
}

export function OutlinePanel({ api, worktreeId, scope = "worktree" }: OutlinePanelProps) {
  const { path, fileScope, isWorkingTreeView, external } = usePreviewedPath(worktreeId, scope);

  const activeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId);
  const activeDirectContextId = useWorkspaceStore((s) => s.activeDirectContextId);
  const layoutKey = worktreeId ?? activeWorktreeId ?? activeDirectContextId ?? "__none__";

  const mode = useWorkspaceStore((s) => s.filesLeftPaneMode[worktreeId ?? "__none__"] ?? "tree");
  const pushJump = useWorkspaceStore((s) => s.pushJump);

  const [symbols, setSymbols] = useState<OutlineSymbol[]>([]);
  const [loading, setLoading] = useState(false);
  // True while retrying after a 409 LSP_NOT_READY — distinct from `loading`
  // so a freshly-spawned language server shows "Starting…" instead of
  // silently landing on the indistinguishable "No symbols" empty state.
  const [starting, setStarting] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [collapsedPaths, setCollapsedPaths] = useState<Record<string, boolean>>({});
  const [activeLine, setActiveLine] = useState<number | null>(null);
  const [symbolColors, setSymbolColors] = useState<Map<string, string>>(new Map());

  // Same theme/language resolution CodeView.tsx uses, so tokenizing here
  // for per-symbol colors (below) matches what the code viewer renders.
  const { theme, themeId } = useTheme();
  const shikiThemeId = themeById[themeId]?.shikiThemeId ?? (theme === "light" ? "light-plus" : "dark-plus");
  const langFilePath = external?.displayPath ?? path ?? undefined;
  const outlineLanguage = langFilePath ? languageForFilePath(langFilePath) : undefined;
  const shikiLang = outlineLanguage ? pickShikiLang(langFilePath, outlineLanguage) : "plaintext";

  // 6.5: Refetch getOutline whenever path OR external.token changes AND filesLeftPaneMode === "outline"
  // Do NOT fetch while mode !== "outline"
  const changeKey = external ? `external:${external.token}` : path ? `workspace:${path}` : null;

  useEffect(() => {
    if (mode !== "outline") return;
    if (!isWorkingTreeView) return;
    if (!changeKey || !worktreeId) return;

    let cancelled = false;
    setLoading(true);
    setStarting(false);
    setUnsupported(false);

    const fileRef: LspFileRef = external
      ? { kind: "external", token: external.token }
      : { kind: "workspace", path: path! };

    // A freshly-spawned language server (spawn-on-first-use) answers its
    // FIRST request with 409 LSP_NOT_READY while it finishes initializing —
    // this is normal and transient (observed ~2-3s for typescript-language-
    // server), not "this file has no symbols". Retry with a short delay
    // instead of the previous behavior, which caught this error the same as
    // any other and rendered the permanent, indistinguishable "No symbols in
    // this file" empty state. Mirrors CodeView.tsx's go-to-def 409 handling
    // (isLspNotReady), just with more attempts since this fetch is automatic
    // (on file open) rather than user-click-triggered.
    const MAX_ATTEMPTS = 8;
    const RETRY_DELAY_MS = 750;

    void (async () => {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          const res = await getOutline(api, fileScope, worktreeId, fileRef);
          if (cancelled) return;
          if ("unsupported" in res && res.unsupported) {
            setUnsupported(true);
            setSymbols([]);
          } else if ("symbols" in res) {
            setSymbols(res.symbols);
            setCollapsedPaths(computeDefaultCollapsed(res.symbols));
            setUnsupported(false);
          }
          setStarting(false);
          setLoading(false);
          return;
        } catch (err) {
          if (cancelled) return;
          if (isLspNotReady(err) && attempt < MAX_ATTEMPTS - 1) {
            setStarting(true);
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
            continue;
          }
          setSymbols([]);
          setStarting(false);
          setLoading(false);
          return;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, mode, isWorkingTreeView, changeKey, worktreeId, fileScope, external?.token, path]);

  // Resolve each symbol's declaration-line color by tokenizing the real file
  // content with the code viewer's own Shiki theme/language — separate from
  // the outline fetch above so a theme switch alone (no file/symbol change)
  // recomputes colors without re-fetching symbols. See "Any update so far?"
  // follow-up: static per-kind CSS colors didn't match the file preview.
  useEffect(() => {
    if (mode !== "outline") return;
    if (!isWorkingTreeView) return;
    if (!changeKey || !worktreeId) return;
    if (symbols.length === 0) {
      setSymbolColors(new Map());
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const code = external
          ? await getExternalFile(api, fileScope, worktreeId, external.token)
          : await getWorkspaceFile(api, fileScope, worktreeId, path!);
        if (cancelled) return;
        const colors = await resolveSymbolColors(code, shikiLang, shikiThemeId, symbols);
        if (!cancelled) setSymbolColors(colors);
      } catch {
        // Fetch/tokenize failure (huge file, unsupported language, network
        // error) → leave symbolColors empty; rows fall back to the static
        // per-kind CSS color instead of losing all styling.
        if (!cancelled) setSymbolColors(new Map());
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, mode, isWorkingTreeView, changeKey, worktreeId, fileScope, external?.token, path, symbols, shikiLang, shikiThemeId]);

  // 6.6: Scroll-position highlight
  useEffect(() => {
    if (mode !== "outline" || !isWorkingTreeView) return;

    const findContainer = () =>
      document.querySelector<HTMLElement>(".preview-body") ??
      document.querySelector<HTMLElement>(".workspace-code");

    const handleScroll = () => {
      const container = findContainer();
      if (!container) return;
      const topmost = findTopmostVisibleLine(container);
      if (topmost !== null) {
        setActiveLine(topmost);
      }
    };

    const container = findContainer();
    const target = container ?? window;
    target.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    handleScroll();

    return () => {
      target.removeEventListener("scroll", handleScroll, { capture: true });
    };
  }, [mode, isWorkingTreeView, path, external?.token, symbols]);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedPaths((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  }, []);

  const handleRowClick = useCallback(
    (sym: OutlineSymbol) => {
      // Mark this row highlighted immediately on click — same `activeLine`
      // state the scroll-driven highlight (6.6) already reads, so selecting
      // a symbol highlights both the outline row AND the code line (the
      // code line highlight already worked via pushJump below; the row
      // itself only picked up a highlight lazily, if/when the resulting
      // scroll happened to fire a scroll event — setting it directly here
      // makes the row highlight immediate and click-driven, not incidental).
      setActiveLine(sym.line + 1);
      if (external) {
        pushJump({
          worktreeId: layoutKey,
          path: external.displayPath,
          line: sym.line + 1,
          matchText: null,
          source: "outline",
          external: {
            token: external.token,
            displayPath: external.displayPath,
          },
        });
      } else if (path) {
        pushJump({
          worktreeId: layoutKey,
          path,
          line: sym.line + 1,
          matchText: null,
          source: "outline",
        });
      }
    },
    [external, path, layoutKey, pushJump]
  );

  const highlightedSymbol = useMemo(() => {
    if (activeLine === null) return null;
    return findInnermostSymbol(symbols, activeLine - 1);
  }, [symbols, activeLine]);

  const filteredSymbols = useMemo(() => {
    return filterSymbols(symbols, filterText);
  }, [symbols, filterText]);

  if (mode !== "outline") {
    return null;
  }

  // Gated off when !isWorkingTreeView
  if (!isWorkingTreeView) {
    return (
      <div className="outline-panel" tabIndex={0} role="region" aria-label="Outline panel">
        <div className="outline-panel__empty" data-testid="outline-unavailable">
          Outline unavailable
        </div>
      </div>
    );
  }

  // No file open
  if (!path && !external) {
    return (
      <div className="outline-panel" tabIndex={0} role="region" aria-label="Outline panel">
        <div className="outline-panel__empty">No file open</div>
      </div>
    );
  }

  const displayPath = external?.displayPath ?? path ?? "";
  const extMatch = displayPath.match(/\.[^./\\]+$/);
  const fileExt = extMatch ? extMatch[0] : "";

  const renderTree = (items: OutlineSymbol[], parentId = "") => {
    return (
      <ul className="outline-panel__list" role="tree">
        {items.map((sym, idx) => {
          const symId = buildSymId(parentId, sym, idx);
          const isCollapsed = Boolean(collapsedPaths[symId]);
          const hasChildren = sym.children && sym.children.length > 0;
          const kindClass = getSymbolKindClass(sym.kind);
          const isHighlighted =
            highlightedSymbol !== null &&
            highlightedSymbol.name === sym.name &&
            highlightedSymbol.kind === sym.kind &&
            highlightedSymbol.line === sym.line &&
            highlightedSymbol.endLine === sym.endLine;

          return (
            <li
              key={symId}
              className="outline-panel__item"
              role="treeitem"
              aria-expanded={hasChildren ? !isCollapsed : undefined}
            >
              <div
                className={`outline-panel__row${isHighlighted ? " outline-panel__row--highlighted" : ""}`}
                data-highlighted={isHighlighted ? "true" : undefined}
                onClick={() => handleRowClick(sym)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleRowClick(sym);
                  }
                }}
              >
                {hasChildren ? (
                  <button
                    type="button"
                    className="outline-panel__toggle"
                    aria-label={isCollapsed ? `Expand ${sym.name}` : `Collapse ${sym.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCollapse(symId);
                    }}
                  >
                    {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  </button>
                ) : (
                  <span className="outline-panel__toggle-spacer" />
                )}
                {getSymbolIcon(sym.kind, kindClass, symbolColors.get(colorKey(sym.line, sym.name)))}
                <span
                  className={`outline-panel__symbol-name${kindClass ? ` outline-panel__symbol-name--${kindClass}` : ""}`}
                  style={
                    symbolColors.has(colorKey(sym.line, sym.name))
                      ? { color: symbolColors.get(colorKey(sym.line, sym.name)) }
                      : undefined
                  }
                  title={sym.name}
                >
                  {sym.name}
                </span>
                <span className="outline-panel__symbol-kind">{sym.kind}</span>
                <span className="outline-panel__line-num">{sym.line + 1}</span>
              </div>
              {hasChildren && !isCollapsed && renderTree(sym.children, symId)}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div className="outline-panel" tabIndex={0} role="region" aria-label="Outline panel">
      <div className="outline-panel__header">
        <div className="outline-panel__filter-box">
          <Search size={14} className="outline-panel__filter-icon" aria-hidden />
          <input
            type="text"
            className="outline-panel__filter-input"
            placeholder="Filter symbols…"
            aria-label="Filter symbols"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
          />
        </div>
      </div>

      <div className="outline-panel__content">
        {loading && starting ? (
          <div className="outline-panel__loading">Starting language server…</div>
        ) : loading ? (
          <div className="outline-panel__loading">Loading symbols…</div>
        ) : unsupported ? (
          <div className="outline-panel__empty">
            Outline not available for {fileExt || "this file"}
          </div>
        ) : symbols.length === 0 ? (
          <div className="outline-panel__empty">No symbols in this file</div>
        ) : filteredSymbols.length === 0 ? (
          <div className="outline-panel__empty">No symbols matching &ldquo;{filterText}&rdquo;</div>
        ) : (
          renderTree(filteredSymbols)
        )}
      </div>
    </div>
  );
}
