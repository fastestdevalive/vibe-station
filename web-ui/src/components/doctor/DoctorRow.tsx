import type { ApiInstance } from "@/api";
import type { DoctorCheckDto, DoctorCheckStatus } from "@/api/types";
import { CommandBlock } from "./CommandBlock";
import { DoctorHintBlock } from "./DoctorHintBlock";
import { DoctorItemsList } from "./DoctorItemsList";
import "./doctor.css";

const STATUS_GLYPH: Record<DoctorCheckStatus, string> = { ok: "✓", warn: "⚠", error: "✗", timeout: "—" };
const STATUS_LABEL: Record<DoctorCheckStatus, string> = {
  ok: "OK",
  warn: "Warning",
  error: "Missing",
  timeout: "Timeout",
};

export interface DoctorRowProps {
  api: ApiInstance;
  check: DoctorCheckDto;
  hostOs: string;
  hostname: string;
  /** Re-run the doctor after an in-app action (Forget / Kill). */
  onChanged: () => void;
  itemsCollapsedCount?: number;
}

/**
 * One doctor check: fixed-width status chip, name + message, and — when it is
 * not OK — the daemon's hint (why + commands) and any per-item rows. Hint text
 * always comes from the daemon; the only client-side fallback is the legacy
 * single `installHint` command from a daemon that predates structured hints.
 */
export function DoctorRow({ api, check, hostOs, hostname, onChanged, itemsCollapsedCount }: DoctorRowProps) {
  const failing = check.status !== "ok";
  const items = check.items ?? [];

  return (
    <div className="doctor-row" data-check={check.name}>
      <span className={`doctor-row__chip doctor-row__chip--${check.status}`}>
        <span aria-hidden="true">{STATUS_GLYPH[check.status]}</span>
        <span>{STATUS_LABEL[check.status]}</span>
      </span>
      <div className="doctor-row__body">
        <div className="doctor-row__head">
          <span className="doctor-row__name">{check.name}</span>
          {check.message ? <span className="doctor-row__message selectable">{check.message}</span> : null}
        </div>
        {!failing && check.resolvedPath ? (
          <div className="doctor-row__path selectable">{check.resolvedPath}</div>
        ) : null}
        {failing && check.hint ? (
          <DoctorHintBlock hint={check.hint} hostOs={hostOs} hostname={hostname} />
        ) : null}
        {failing && !check.hint && check.installHint ? (
          <div className="doctor-hint">
            <CommandBlock command={check.installHint} />
          </div>
        ) : null}
        {failing && items.length > 0 ? (
          <DoctorItemsList
            api={api}
            items={items}
            collapsedCount={itemsCollapsedCount}
            onChanged={onChanged}
          />
        ) : null}
      </div>
    </div>
  );
}
