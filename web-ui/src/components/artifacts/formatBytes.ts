/** Human size for the preview state panels ("14 MB", "3.2 MB", "812 KB"); decimal units like the design copy. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  const rounded = v >= 100 || Number.isInteger(v) ? Math.round(v) : Math.round(v * 10) / 10;
  return `${rounded} ${units[i]}`;
}
