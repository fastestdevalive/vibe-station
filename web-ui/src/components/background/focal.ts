// Adding a wallpaper: catalog.json (daemon) + this table + assets/thumbs; thumbs.test.ts checks all three.
/**
 * Vertical focal point per wallpaper, as a percentage of the image height.
 *
 * Generated from the design's `_generators/focal169_pos.json` (the same table
 * the design's 16:9 crops use), so a `background-position: 50% <focal>%` cut
 * matches the design thumbs (`assets/thumbs/wp-NNN.jpg`) exactly.
 */
export const FOCAL_Y: Record<string, number> = {
  "wp-001": 58,
  "wp-002": 42,
  "wp-003": 82,
  "wp-004": 45,
  "wp-005": 74,
  "wp-006": 79,
  "wp-007": 34,
  "wp-008": 50,
  "wp-009": 58,
  "wp-010": 82,
  "wp-011": 31,
  "wp-012": 50,
  "wp-013": 50,
  "wp-014": 85,
  "wp-015": 42,
  "wp-016": 32,
  "wp-017": 50,
  "wp-018": 38,
  "wp-019": 46,
  "wp-020": 58,
  "wp-021": 66,
  "wp-022": 76,
  "wp-023": 82,
  "wp-024": 50,
  "wp-025": 67,
  "wp-026": 41,
  "wp-027": 68,
  "wp-028": 66,
  "wp-029": 41,
  "wp-030": 66,
  "wp-031": 69,
};

/** CSS `object-position` / `background-position` for one wallpaper. Unknown
 *  ids centre vertically, matching the design's default crop. */
export function objectPosition(id: string): string {
  return `50% ${FOCAL_Y[id] ?? 50}%`;
}
