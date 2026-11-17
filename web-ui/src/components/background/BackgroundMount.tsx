import { useInRouterContext } from "react-router-dom";
import { ScopePickerDialog } from "./ScopePickerDialog";
import { useScopeSweep } from "./useScopeSweep";
import { WindowBackground } from "./WindowBackground";

/**
 * Everything the wallpaper feature mounts outside a pane: the window layer, the
 * scope-picker host and the deleted-scope sweep. Kept in one child component so
 * nothing router-dependent runs when `Layout` renders without a router (several
 * tests do) — the same pattern as `AboutSetting`'s `useInRouterContext()` check.
 */
function BackgroundLayer() {
  useScopeSweep();
  return (
    <>
      <WindowBackground />
      <ScopePickerDialog />
    </>
  );
}

export function BackgroundMount() {
  const inRouter = useInRouterContext();
  return inRouter ? <BackgroundLayer /> : null;
}
