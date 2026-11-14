import type { ReactNode } from "react";
import { ModeHeaderActionsHost, ToolActionsHost } from "@/components/layout/TopActionsSlot";
import type { ListHeaderMode } from "@/context/ToolsInsetContext";

export interface RailHeaderProps {
  /** Files-pane mode of this header (`host="mode"`). Ignored for `host="tool"`. */
  mode?: ListHeaderMode;
  /** `mode`: `ModeHeaderActionsHost` (the list shares the pane with a Files bar). `tool`: plain `ToolActionsHost`
   *  (a full-pane list, e.g. the VCS commit list when no commit is picked). The host is always the LAST child. */
  host?: "mode" | "tool";
  /** Legacy class kept so existing height / gutter rules (`workspace.css`, `artifacts.css`) keep applying. */
  className?: string;
  /** Identity: a title with a muted count, or a view switch. Truncates last. */
  left: ReactNode;
  /** At most two controls, packed right (one text dropdown, then one icon). */
  right?: ReactNode;
}

/**
 * The one 35px header for every rail list (Files, Commits, Artifacts): identity left, at most two controls right,
 * the chip reserve last. Rule 6 of the tools-pane-rework board: `actions-row` + the host last, so the right end
 * stops where the chip's reserve begins.
 */
export function RailHeader({ mode, host = "mode", className, left, right }: RailHeaderProps) {
  return (
    <div
      className={`rail-header actions-row pane-header pane-header--compact${className ? ` ${className}` : ""}`}
      style={{
        height: "var(--pane-row-h)",
        minHeight: "var(--pane-row-h)",
        maxHeight: "var(--pane-row-h)",
        boxSizing: "border-box",
      }}
    >
      <div className="rail-header__left">{left}</div>
      <span className="rail-header__sp" aria-hidden />
      {right ? <div className="rail-header__right">{right}</div> : null}
      {host === "tool" || mode === undefined ? <ToolActionsHost /> : <ModeHeaderActionsHost mode={mode} />}
    </div>
  );
}
