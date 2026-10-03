/** User-facing CLI names. The CliId (`codex`, `pi`, …) stays the wire/storage
 *  value; only what is rendered goes through here. Unknown ids pass through. */
const CLI_DISPLAY_NAMES: Record<string, string> = {
  codex: "Codex",
  pi: "Pi",
};

export function cliDisplayName(cli: string): string {
  return CLI_DISPLAY_NAMES[cli] ?? cli;
}
