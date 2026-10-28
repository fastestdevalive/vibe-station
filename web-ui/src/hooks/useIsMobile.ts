import { useMediaQuery } from "@/hooks/useMediaQuery";

/**
 * The ONE phone-layout breakpoint for JS. CSS `@media` blocks cannot read a variable, so they keep the literal
 * `(max-width: 768px)`: when this changes, change every `@media (max-width: 768px)` block in `styles/` and the
 * feature `.css` files with it (`grep -rn "max-width: 768px"`).
 */
export const MOBILE_QUERY = "(max-width: 768px)";

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}
