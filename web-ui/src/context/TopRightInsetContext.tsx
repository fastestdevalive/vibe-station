import { createContext, useContext, type ReactNode } from "react";

export interface TopRightInsetContextValue {
  /** Width in pixels of the floating top-right controls widget (0 when not underneath). */
  width: number;
  /** Height in pixels of the floating top-right controls widget (0 when not underneath). */
  height: number;
}

const DEFAULT_INSET: TopRightInsetContextValue = {
  width: 0,
  height: 0,
};

const TopRightInsetContext = createContext<TopRightInsetContextValue>(DEFAULT_INSET);

export function TopRightInsetProvider({
  value,
  children,
}: {
  value: TopRightInsetContextValue;
  children: ReactNode;
}) {
  return (
    <TopRightInsetContext.Provider value={value}>
      {children}
    </TopRightInsetContext.Provider>
  );
}

export function useTopRightInset(): TopRightInsetContextValue {
  return useContext(TopRightInsetContext);
}
