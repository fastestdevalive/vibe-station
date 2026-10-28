/**
 * Shared layout sizes whose CSS twins are variables declared once on `.app-shell` (`styles/workspace.css`):
 * `--pane-row-h` = PANE_ROW_H, `--tools-toggle-size` = TOOLS_TOGGLE_SIZE, `--tools-rail-col-w` = TOOLS_RAIL_COL_W. `styles/anchorCss.test.ts` fails if
 * a pair drifts. Inline styles use the CSS vars/strings below; only arithmetic needs the numbers.
 */
export const PANE_ROW_H = 35;
export const TOOLS_TOGGLE_SIZE = 28;
export const TOOLS_RAIL_COL_W = 36;

/** Docked list (Files list, VCS commit's changed files) sizes in px: default, bounds, persisted per context. */
export const FILES_LEFT_PANE_DEFAULT_WIDTH = 240;
export const FILES_LEFT_PANE_MIN_WIDTH = 160;
export const FILES_LEFT_PANE_MAX_WIDTH = 600;
/** Desktop floor: the open list's header reserves the actions chip (105px - 36px rail + the offline pill's 76px = 145px),
 *  so below 145px + room for the header's own items the chip would cover them. Phones have no chip: they keep 160.
 *  `anchorCss.test.ts` ties this to the chip tokens. */
export const FILES_LEFT_PANE_MIN_WIDTH_DESKTOP = 224;
export const FILES_LEFT_PANE_DEFAULT_HEIGHT = 240;
export const FILES_LEFT_PANE_MIN_HEIGHT = 100;
export const FILES_LEFT_PANE_MAX_HEIGHT = 600;

/** Width of the side-by-side list pane; `DockedListLayout` is the only writer of the var (the fallback is the default size). */
export const LIST_PANE_W = `var(--list-pane-w, ${FILES_LEFT_PANE_DEFAULT_WIDTH}px)`;
/** Height of the stacked list pane. */
export const LIST_PANE_H = `var(--list-pane-h, ${FILES_LEFT_PANE_DEFAULT_HEIGHT}px)`;
