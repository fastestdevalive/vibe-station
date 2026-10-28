import { createContext, useContext, type ReactNode } from "react";
import type { FilesLeftPaneMode } from "@/hooks/useStore";

/** Which list header hosts the actions: a files-pane mode, or the VCS commit view's changed-file list. */
export type ListHeaderMode = FilesLeftPaneMode | "commit";

/** What a `ToolPanel` tells its descendants about hosting the shared actions (no insets remain: the name is historical). */
export interface ToolsInsetContextValue {
  /** Whether the docked list panel (Files list, or the VCS commit view's changed-file list) is open. */
  isPanelOpen: boolean;
  /** An open list's mode header carries the pane controls: stacked on any size, side-by-side on phones. */
  listHostsPane: boolean;
  /** Unique per `ToolPanel`; selects this panel's host in the actions registry. */
  hostScope: string;
  /** This panel may reserve the chip's width (active context, not a canvas tile). */
  hostsGlobal: boolean;
  /** Desktop side-by-side list is open in the global panel: its mode header reserves the actions chip's width. */
  listHostsGlobal: boolean;
  /** Active files-left-pane mode of this panel (selects which mode header hosts the actions). */
  filesMode: ListHeaderMode;
}

const DEFAULT_INSET: ToolsInsetContextValue = {
  isPanelOpen: false,
  listHostsPane: false,
  hostScope: "",
  hostsGlobal: false,
  listHostsGlobal: false,
  filesMode: "tree",
};

const ToolsInsetContext = createContext<ToolsInsetContextValue>(DEFAULT_INSET);

export function ToolsInsetProvider({
  value,
  children,
}: {
  value: ToolsInsetContextValue;
  children: ReactNode;
}) {
  return (
    <ToolsInsetContext.Provider value={value}>
      {children}
    </ToolsInsetContext.Provider>
  );
}

export function useToolsInset(): ToolsInsetContextValue {
  return useContext(ToolsInsetContext);
}
