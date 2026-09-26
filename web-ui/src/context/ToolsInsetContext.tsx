import { createContext, useContext, type ReactNode } from "react";

export interface ToolsInsetContextValue {
  /** Whether the files left panel (overlay) is currently expanded/open. */
  isPanelOpen: boolean;
}

const DEFAULT_INSET: ToolsInsetContextValue = {
  isPanelOpen: false,
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
