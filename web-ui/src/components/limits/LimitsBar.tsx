import { useEffect, useRef, useState } from "react";
import { useEventTargets } from "@/context/DemoEnv";
import type { LimitSlotRef } from "@/api/types";
import { useLimits } from "@/hooks/useLimits";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { LimitChip } from "./LimitChip";
import { LimitsPopup } from "./LimitsPopup";
import type { SlotIndex } from "./limitsModel";
import "@/styles/limits.css";

const TICK_MS = 30_000;
const COOLDOWN_TICK_MS = 1_000;

export function LimitsBar() {
  const { snapshot, error, refreshing, cooldownUntil, slots, windowFor, refresh, assignSlot } =
    useLimits();
  const isMobile = useMediaQuery("(max-width: 768px)");
  const { doc } = useEventTargets();

  const [openSlot, setOpenSlot] = useState<SlotIndex | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const rootRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([null, null]);

  // Presentation clock only — refreshes the countdown/"as of" labels every 30s.
  // It is NOT a data poll; the data layer owns its own WS/REST cadence.
  // Ticks every second while a refresh cooldown is counting down so its label stays accurate.
  const coolingDown = cooldownUntil != null && nowMs < cooldownUntil;
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), coolingDown ? COOLDOWN_TICK_MS : TICK_MS);
    return () => clearInterval(id);
  }, [coolingDown]);

  // Outside mousedown closes the open popup (same pattern as LspStatusRow).
  useEffect(() => {
    if (openSlot === null) return;
    const onOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpenSlot(null);
      }
    };
    doc.addEventListener("mousedown", onOutside);
    return () => doc.removeEventListener("mousedown", onOutside);
  }, [openSlot, doc]);

  // Render nothing until the first snapshot or an error — avoids a layout jump
  // while the limits load. On fetch failure we still render the two default
  // "—" chips so the bar never silently disappears.
  if (snapshot === null && !error) return null;

  const handleClose = () => {
    const idx = openSlot;
    setOpenSlot(null);
    if (idx !== null) chipRefs.current[idx]?.focus();
  };

  const handlePick = (ref: LimitSlotRef) => {
    if (openSlot === null) return;
    assignSlot(openSlot, ref);
    const idx = openSlot;
    setOpenSlot(null);
    chipRefs.current[idx]?.focus();
  };

  const windowForSlot = (i: SlotIndex) => windowFor(slots[i]);

  return (
    <div className="limits-bar" ref={rootRef}>
      {(slots as [LimitSlotRef, LimitSlotRef]).map((slot, i) => {
        const idx = i as SlotIndex;
        return (
          <LimitChip
            key={`${slot.harness}/${slot.windowId}`}
            harness={slot.harness}
            window={windowForSlot(idx)}
            fallbackWindowId={slot.windowId}
            nowMs={nowMs}
            variant="bar"
            slotLabel={`Slot ${idx + 1}`}
            expanded={openSlot === idx}
            onClick={() => setOpenSlot(openSlot === idx ? null : idx)}
            buttonRef={(el) => {
              chipRefs.current[idx] = el;
            }}
          />
        );
      })}
      {openSlot !== null && snapshot ? (
        <>
          {isMobile && (
            <div
              className="limits-popup-backdrop"
              role="presentation"
              onClick={handleClose}
            />
          )}
          <LimitsPopup
            slotIndex={openSlot}
            slots={snapshot.slots}
            harnesses={snapshot.harnesses}
            host={snapshot.host}
            nowMs={nowMs}
            refreshing={refreshing}
            cooldownUntil={cooldownUntil}
            error={error}
            onPick={handlePick}
            onRefresh={refresh}
            onClose={handleClose}
          />
        </>
      ) : null}
    </div>
  );
}
