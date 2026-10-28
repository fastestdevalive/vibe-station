import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { rowMarkRange, commentSpan, type MarkSource } from "./rowIndex";
import { DRAFT_ID } from "./draftComment";
import type { PinPlacement } from "./pinGeometry";
import type { PinHostHandle, PinMeasurer, PinTarget } from "./pinMeasurer";
import type { ReviewComment } from "@/api/types";

const NONE: PinPlacement[] = [];

/**
 * Register `hostRef` with the surface's measurer and return the placements for `targets`. Nothing is measured
 * during render: the measurer reads in one animation frame and calls back with the result. `textSel` is the
 * element inside the host whose text the targets' columns index (`null` = the host itself, for markdown).
 * `contentKey` changes whenever the text is re-rendered (row html), so the pins are re-measured.
 */
export function usePinHost(
  measurer: PinMeasurer | null | undefined,
  hostRef: RefObject<HTMLElement | null>,
  textSel: string | null,
  targets: readonly PinTarget[],
  contentKey: unknown,
): PinPlacement[] {
  const [placements, setPlacements] = useState<PinPlacement[]>(NONE);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const handle = useRef<PinHostHandle | null>(null);
  const has = targets.length > 0;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!measurer || !host || !has) {
      setPlacements((p) => (p.length ? NONE : p));
      return;
    }
    handle.current = measurer.register({
      host,
      textEl: () => (textSel ? host.querySelector<HTMLElement>(textSel) : host),
      targets: () => targetsRef.current,
      apply: setPlacements,
    });
    return () => {
      handle.current?.unregister();
      handle.current = null;
    };
  }, [measurer, hostRef, textSel, has]);

  const sig = targets.map((t) => `${t.id}:${t.pin}:${t.endCol ?? ""}:${t.outdated ? 1 : 0}`).join("|");
  useLayoutEffect(() => {
    handle.current?.markDirty();
  }, [sig, contentKey, measurer, has]);

  return has ? placements : NONE;
}

/**
 * Pin targets of one code / diff row: the comments that END on it, plus the open box's draft pin and the
 * edited comment's active ring. `endCol` is where the quote ends inside THIS row's text (the last character
 * the pin lines up with); null (outdated comment or blank row) means "the end of the row".
 */
export function rowPinTargets(
  pins: readonly ReviewComment[] | undefined,
  draft: MarkSource | undefined,
  activeId: string | null | undefined,
  rowText: string,
  label: (c: ReviewComment) => string,
): PinTarget[] {
  const out: PinTarget[] = [];
  for (const c of pins ?? []) {
    const end = commentSpan(c)?.end;
    out.push({
      id: c.id,
      pin: c.pin,
      outdated: c.anchor === "outdated",
      active: c.id === activeId,
      label: label(c),
      endCol: c.anchor === "outdated" || end == null ? null : (rowMarkRange(c, rowText, end)?.end ?? null),
    });
  }
  if (draft) {
    const end = commentSpan(draft)?.end;
    out.push({ id: DRAFT_ID, pin: 0, draft: true, endCol: end == null ? null : (rowMarkRange(draft, rowText, end)?.end ?? null) });
  }
  return out;
}

/** `rowPinTargets`, memoised on what it depends on (a memo'd row keeps its identity so the host is not re-registered). */
export function useRowPinTargets(
  pins: readonly ReviewComment[] | undefined,
  draft: MarkSource | undefined,
  activeId: string | null | undefined,
  rowText: string,
  label: ((c: ReviewComment) => string) | undefined,
): PinTarget[] {
  return useMemo(() => (label ? rowPinTargets(pins, draft, activeId, rowText, label) : []), [pins, draft, activeId, rowText, label]);
}
