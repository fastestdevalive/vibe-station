import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * When the open task goes set -> null within the SAME session (Esc, Back, task lost), restore focus:
 * the originating tray row, else the tray chip/header, else the composer. Runs as a layout effect so
 * it lands after `inert` was removed from the chat. Gated like the composer's focus-on-mount.
 */
export function useTaskFocusReturn(opts: {
  paneRef: RefObject<HTMLElement | null>;
  sessionId: string | null;
  openTaskId: string | null;
  enabled: boolean;
  focusComposer: () => void;
}) {
  const { paneRef, sessionId, openTaskId, enabled, focusComposer } = opts;
  const prev = useRef<{ sessionId: string | null; openTaskId: string | null }>({ sessionId, openTaskId });
  useLayoutEffect(() => {
    const last = prev.current;
    prev.current = { sessionId, openTaskId };
    if (!enabled || last.sessionId !== sessionId || !last.openTaskId || openTaskId !== null) return;
    const root = paneRef.current;
    const row = root?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(last.openTaskId)}"]`);
    const chip = root?.querySelector<HTMLElement>('[data-testid="task-tray-chip"], [data-testid="task-tray-head"]');
    if (row) row.focus();
    else if (chip) chip.focus();
    else focusComposer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, openTaskId]);
}
