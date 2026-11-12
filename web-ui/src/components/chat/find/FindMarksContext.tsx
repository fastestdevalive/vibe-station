import { createContext, useContext, useMemo, type ReactNode } from "react";

export interface FindMarksValue {
  terms: string[];
  scope: "messages" | "all";
}

export const FindMarksContext = createContext<FindMarksValue | null>(null);

export function useFindMarks(): FindMarksValue | null {
  return useContext(FindMarksContext);
}

export function FindMarksProvider({
  terms,
  scope,
  children,
}: {
  terms: string[];
  scope: "messages" | "all";
  children: ReactNode;
}) {
  // Memoized on the joined terms + scope. Deriving the array from the key
  // keeps the dependency list complete without an eslint suppression.
  const termsKey = terms.join("\0");
  const value = useMemo<FindMarksValue | null>(() => {
    if (termsKey === "") return null;
    return { terms: termsKey.split("\0"), scope };
  }, [termsKey, scope]);

  return (
    <FindMarksContext.Provider value={value}>
      {children}
    </FindMarksContext.Provider>
  );
}
