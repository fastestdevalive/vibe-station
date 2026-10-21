import type { ReactNode } from "react";
import "./settings.css";

/**
 * Shared settings row: label + muted help on the left, control on the right,
 * hairline divider below. Styles live in settings.css (`.settings-row*`).
 * `mono` renders the label in the mono face (paths, ids, versions only).
 */
export function SettingsRow({
  label,
  description,
  control,
  mono,
}: {
  label: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row__main">
        <div className={mono ? "settings-row__label settings-mono" : "settings-row__label"}>{label}</div>
        {description && <div className="settings-row__desc">{description}</div>}
      </div>
      {control !== undefined && <div className="settings-row__control">{control}</div>}
    </div>
  );
}
