import { CircleAlert } from "lucide-react";
import { checkFireAt } from "@/components/chat/ScheduleSendPopover";

export type PickerWhen = "now" | "later";

interface ReviewPickerWhenProps {
  when: PickerWhen;
  onWhen: (w: PickerWhen) => void;
  /** `datetime-local` value (local wall time, minute precision). */
  value: string;
  onValue: (v: string) => void;
  /** Earliest pickable minute (`datetime-local` value). */
  min: string;
  error: string | null;
  /** Enter on this control runs the picker's primary button. */
  onEnter: () => void;
}

/**
 * `Sat 31 Oct, 6:30 PM · PDT (America/Los_Angeles)`: the resolved fire time, so a DST shift is visible. Takes the
 * ISO instant `checkFireAt` validated (NOT the `datetime-local` string: in a repeated DST hour that string parses to
 * the first, already past occurrence while the second one is what gets scheduled).
 */
export function describeFireTime(iso: string): string | null {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return null;
  const when = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value;
  const iana = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${when}${zone ? ` · ${zone}` : ""}${iana ? ` (${iana})` : ""}`;
}

const OPTIONS: { id: PickerWhen; label: string }[] = [
  { id: "now", label: "Now" },
  { id: "later", label: "Later" },
];

/** The picker's When control: Now | Later, and for Later one date + time input in the same popup. */
export function ReviewPickerWhen({ when, onWhen, value, onValue, min, error, onEnter }: ReviewPickerWhenProps) {
  const fire = when === "later" && !error ? checkFireAt(value) : null;
  const resolved = fire && "iso" in fire ? describeFireTime(fire.iso) : null;
  return (
    <div className="comment-picker__when">
      <div role="radiogroup" aria-label="When" className="comment-picker__seg">
        {OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={when === o.id}
            tabIndex={when === o.id ? 0 : -1}
            className={`comment-picker__seg-btn${when === o.id ? " comment-picker__seg-btn--on" : ""}`}
            onClick={() => onWhen(o.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onEnter();
              } else if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const next = o.id === "now" ? "later" : "now";
                onWhen(next);
                (e.currentTarget.parentElement?.querySelector(`[data-when="${next}"]`) as HTMLElement | null)?.focus();
              }
            }}
            data-when={o.id}
          >
            {o.label}
          </button>
        ))}
      </div>
      {when === "later" ? (
        <>
          <input
            type="datetime-local"
            aria-label="Send at"
            className="input comment-picker__datetime"
            value={value}
            min={min}
            aria-invalid={error ? true : undefined}
            onChange={(e) => onValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onEnter();
              }
            }}
          />
          {resolved ? <div className="comment-picker__fires">{`Fires ${resolved}`}</div> : null}
          {error ? (
            <div className="comment-picker__when-error" role="alert">
              <CircleAlert size={13} aria-hidden />
              <span>{error}</span>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
