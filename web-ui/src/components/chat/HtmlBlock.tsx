import { memo, useId, useMemo } from "react";
import { useRowOpen } from "./rowUiState";
import { HtmlView, isOverHtmlCap } from "@/components/preview/HtmlView";
import { MarkdownView } from "@/components/preview/MarkdownView";

/**
 * Chat card for a closed ```html fence in an assistant message (Decision 10).
 * Preview/Source tabs: Preview shows the sandboxed `HtmlView`; Source reuses
 * `MarkdownView` with a re-fenced block so highlighting and copy come free.
 * Oversize content starts on Source and disables Preview (Decision 8 owner).
 */
export const HtmlBlock = memo(function HtmlBlock({
  source,
  stateKey,
}: {
  source: string;
  /** Row-store key prefix (message row + segment index) so tab/expand state survives virtualized remounts. */
  stateKey?: string;
}): React.JSX.Element {
  const baseId = useId();
  const previewId = `${baseId}-preview`;
  const sourceId = `${baseId}-source`;
  const panelId = `${baseId}-panel`;

  const overCap = useMemo(() => isOverHtmlCap(source, "chat"), [source]);
  const [showSource, setShowSource] = useRowOpen(stateKey ? `${stateKey}:src` : undefined, overCap);
  const [expanded, setExpanded] = useRowOpen(stateKey ? `${stateKey}:exp` : undefined, false);
  const [lightCanvas, setLightCanvas] = useRowOpen(stateKey ? `${stateKey}:light` : undefined, false);
  const ui = { expanded, setExpanded, lightCanvas, setLightCanvas };
  const selected: "preview" | "source" = showSource || overCap ? "source" : "preview";

  const tabs: Array<{ id: "preview" | "source"; label: string; tabId: string }> = [
    { id: "preview", label: "Preview", tabId: previewId },
    { id: "source", label: "Source", tabId: sourceId },
  ];

  function selectTab(tab: "preview" | "source") {
    if (tab === "preview" && overCap) return;
    setShowSource(tab === "source");
  }

  function onKeyDown(e: React.KeyboardEvent, current: "preview" | "source") {
    const order: Array<"preview" | "source"> = ["preview", "source"];
    const idx = order.indexOf(current);
    let next: "preview" | "source" | null = null;
    if (e.key === "ArrowRight") next = order[(idx + 1) % order.length] ?? current;
    else if (e.key === "ArrowLeft") next = order[(idx - 1 + order.length) % order.length] ?? current;
    else if (e.key === "Home") next = order[0] ?? current;
    else if (e.key === "End") next = order[order.length - 1] ?? current;
    if (next) {
      e.preventDefault();
      selectTab(next);
      const el = document.getElementById(next === "preview" ? previewId : sourceId);
      el?.focus();
    }
  }

  return (
    <div className="html-block">
      <div className="html-block__tabs" role="tablist" aria-label="HTML view">
        {tabs.map((t) => {
          const isSelected = selected === t.id;
          const disabled = t.id === "preview" && overCap;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={t.tabId}
              aria-selected={isSelected}
              aria-controls={panelId}
              tabIndex={isSelected ? 0 : -1}
              disabled={disabled}
              title={disabled ? "Too large to render — showing source" : undefined}
              className="html-block__tab"
              onClick={() => selectTab(t.id)}
              onKeyDown={(e) => onKeyDown(e, t.id)}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div className="html-block__panel" role="tabpanel" id={panelId} aria-labelledby={selected === "preview" ? previewId : sourceId}>
        {overCap ? (
          <div className="html-view__notice" role="status">
            Too large to render — showing source
          </div>
        ) : null}
        {selected === "preview" ? (
          <HtmlView source={source} variant="chat" ui={ui} />
        ) : (
          <MarkdownView source={"```html\n" + source + "\n```"} />
        )}
      </div>
    </div>
  );
});
