/**
 * Single source of truth for Settings section ids -> labels. `SettingsPanel`
 * builds its tab list from this and `Workspace` uses it for the mobile TopBar
 * header, so a new section cannot show its raw id there.
 */
export const SETTINGS_SECTION_LABELS: Record<string, string> = {
  modes: "Harnesses and modes",
  appearance: "Appearance",
  markdown: "Markdown",
  projects: "Projects",
  skills: "Skills",
  "hidden-projects": "Archived projects",
  storage: "Storage",
  "remote-access": "Remote Access",
  lsp: "LSP",
  doctor: "Doctor",
  updates: "Updates",
  about: "About",
};

/** Label for `/settings/:sectionId`; falls back to the id for an unknown section. */
export function settingsSectionLabelFor(sectionId: string): string {
  return SETTINGS_SECTION_LABELS[sectionId] ?? sectionId;
}
