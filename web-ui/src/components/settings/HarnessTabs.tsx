import type { KeyboardEvent } from "react";
import type { SupportedCli } from "@/api/types";
import { ModeIcon } from "@/components/agent/ModeIcon";
import { cliDisplayName } from "@/lib/cliNames";
import "./harness.css";
import "./settings.css";

export const harnessTabId = (id: string) => `harness-tab-${id}`;
export const harnessPanelId = (id: string) => `harness-panel-${id}`;

interface HarnessTabsProps {
  clis: SupportedCli[];
  selectedId: string;
  onSelect: (id: string) => void;
}

/**
 * One tab per harness (icon, name, detected dot). WAI-ARIA tabs with automatic
 * activation: arrow keys / Home / End move focus and selection together.
 * The strip scrolls horizontally inside itself so the page never does.
 */
export function HarnessTabs({ clis, selectedId, onSelect }: HarnessTabsProps) {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const idx = clis.findIndex((c) => c.id === selectedId);
    let next = -1;
    if (e.key === "ArrowRight") next = (idx + 1) % clis.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + clis.length) % clis.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = clis.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const target = clis[next]!;
    onSelect(target.id);
    document.getElementById(harnessTabId(target.id))?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="Harnesses"
      aria-orientation="horizontal"
      className="harness-tabs settings-tabs-scroll"
      onKeyDown={onKeyDown}
    >
      {clis.map((cli) => {
        const selected = cli.id === selectedId;
        return (
          <button
            key={cli.id}
            id={harnessTabId(cli.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={harnessPanelId(cli.id)}
            tabIndex={selected ? 0 : -1}
            className="harness-tab"
            data-testid={`harness-tab-${cli.id}`}
            onClick={() => onSelect(cli.id)}
          >
            <span aria-hidden="true" className="harness-tab__icon" style={{ opacity: cli.detected ? 1 : 0.6 }}>
              <ModeIcon iconKey={cli.id} channel="json" size={16} />
            </span>
            <span>{cliDisplayName(cli.id)}</span>
            <span
              className={cli.detected ? "harness-dot harness-dot--ok" : "harness-dot"}
              role="img"
              aria-label={cli.detected ? "detected" : "not found"}
              data-testid={`harness-dot-${cli.id}`}
            />
          </button>
        );
      })}
    </div>
  );
}
