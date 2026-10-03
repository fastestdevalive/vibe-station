import { ModeIcon } from "./ModeIcon";
import { cliDisplayName } from "@/lib/cliNames";

/** A CLI's name with its icon, for radio/option labels. The icon is decorative
 *  (aria-hidden) so the option's accessible name stays just the CLI name. */
export function CliOptionLabel({ cli }: { cli: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}>
      <span aria-hidden="true" style={{ display: "inline-flex" }}>
        <ModeIcon iconKey={cli} channel="json" size={14} />
      </span>
      {cliDisplayName(cli)}
    </span>
  );
}
