import { useEffect, useRef } from "react";
import type { MentionRow } from "./mentionRows";
import { selectableRows } from "./mentionRows";
import type { ParsedMentionQuery } from "./mentionQuery";
import { highlightMatch } from "./mentionFilter";
import { mentionKindDef } from "./kinds";
import { StatusDot } from "@/components/layout/StatusDot";
import { sessionStatus } from "@/lib/worktreeStatus";

export interface MentionPopoverProps {
  rows: MentionRow[];
  activeOrdinal: number;
  parsed: ParsedMentionQuery;
  onHover: (ordinal: number) => void;
  onSelect: (row: Extract<MentionRow, { type: "scope" | "item" }>) => void;
  listboxId: string;
  popoverRef?: React.Ref<HTMLDivElement>;
}

function renderHighlighted(text: string, query: string) {
  const segments = highlightMatch(text, query);
  return segments.map((seg, i) =>
    seg.hit ? <b key={i}>{seg.text}</b> : <span key={i}>{seg.text}</span>,
  );
}

function getFooterText(parsed: ParsedMentionQuery, activeRow?: MentionRow): string {
  if (parsed.scope !== null) {
    return "↑↓ navigate · Enter insert chip · ⌫ leave scope · Esc close · type to filter";
  }
  if (parsed.raw !== "" && parsed.scopeKinds.length > 0 && activeRow?.type === "scope") {
    return `Enter scope to ${activeRow.label} · ↓ pick a result · Esc close`;
  }
  if (activeRow?.type === "scope") {
    return "↑↓ navigate · Enter scope search · Esc close";
  }
  return "↑↓ navigate · Enter insert chip · Esc close";
}

export function MentionPopover({
  rows,
  activeOrdinal,
  parsed,
  onHover,
  onSelect,
  listboxId,
  popoverRef,
}: MentionPopoverProps) {
  const pointerMovedRef = useRef(false);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const el = optionRefs.current[activeOrdinal];
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [activeOrdinal]);

  const selectable = selectableRows(rows);
  const activeRow = selectable[activeOrdinal];

  let currentOrdinal = 0;

  let scopedHeader = null;
  if (parsed.scope !== null) {
    const def = mentionKindDef(parsed.scope);
    const count = selectable.length;
    const text =
      parsed.scope === "project"
        ? `Searching projects · ${count} shown`
        : `Searching ${def.section} in this project · ${count} shown`;
    scopedHeader = (
      <div className="chat-mention-popover__scoped-header" role="presentation">
        <span className="chat-mention-popover__scope-pill">@{def.section}:</span>
        <span>{text}</span>
      </div>
    );
  }

  return (
    <div
      ref={popoverRef}
      className="chat-skill-popover chat-mention-popover"
      role="listbox"
      id={listboxId}
      onMouseMove={() => {
        pointerMovedRef.current = true;
      }}
    >
      {scopedHeader}
      <div className="chat-mention-popover__scroll">
        {rows.map((row, index) => {
          if (row.type === "header") {
            return (
              <div
                key={`header-${index}-${row.title}`}
                className="chat-mention-popover__header"
                role="presentation"
              >
                <span>{row.title}</span>
                {row.caption ? (
                  <span className="chat-mention-popover__header-caption">{row.caption}</span>
                ) : null}
              </div>
            );
          }

          if (row.type === "status") {
            return (
              <div
                key={`status-${index}`}
                className="chat-mention-popover__status"
                role="presentation"
              >
                {row.text}
              </div>
            );
          }

          const ordinal = currentOrdinal++;
          const isSelected = activeOrdinal === ordinal;

          if (row.type === "scope") {
            const def = mentionKindDef(row.kind);
            const Icon = def.Icon;
            return (
              <button
                key={`scope-${row.kind}`}
                ref={(el) => {
                  optionRefs.current[ordinal] = el;
                }}
                type="button"
                role="option"
                tabIndex={-1}
                id={`${listboxId}-${ordinal}`}
                aria-selected={isSelected}
                className={`chat-skill-popover__option chat-mention-popover__option${
                  isSelected ? " chat-skill-popover__option--active" : ""
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(row);
                }}
                onMouseEnter={() => {
                  if (pointerMovedRef.current) onHover(ordinal);
                }}
              >
                <Icon size={14} aria-hidden className="chat-mention-popover__icon" />
                <span className="chat-mention-popover__scope-pill">
                  {renderHighlighted(row.label, parsed.raw)}
                </span>
              </button>
            );
          }

          const def = mentionKindDef(row.item.kind);
          const Icon = def.Icon;

          return (
            <button
              key={`item-${row.item.kind}-${row.item.id}`}
              ref={(el) => {
                optionRefs.current[ordinal] = el;
              }}
              type="button"
              role="option"
              tabIndex={-1}
              id={`${listboxId}-${ordinal}`}
              aria-selected={isSelected}
              className={`chat-skill-popover__option chat-mention-popover__option${
                isSelected ? " chat-skill-popover__option--active" : ""
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(row);
              }}
              onMouseEnter={() => {
                if (pointerMovedRef.current) onHover(ordinal);
              }}
            >
              <Icon size={14} aria-hidden className="chat-mention-popover__icon" />
              {row.item.kind === "agent" && row.item.status ? (
                <StatusDot status={sessionStatus(row.item.status)} />
              ) : null}
              <span className="chat-mention-popover__label">
                {renderHighlighted(row.item.label, parsed.query)}
              </span>
              {row.item.secondary ? (
                <span
                  className="chat-mention-popover__secondary"
                  title={row.item.kind === "file" ? row.item.id : row.item.secondary}
                >
                  {renderHighlighted(row.item.secondary, parsed.query)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="chat-mention-popover__footer" role="presentation">
        {getFooterText(parsed, activeRow)}
      </div>
    </div>
  );
}
