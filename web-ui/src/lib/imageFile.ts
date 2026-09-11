const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "avif",
]);

/** Whether `path` names a binary image file (by extension, case-insensitive). */
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = path.slice(dot + 1).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Resolve a markdown image `src` to a repo file path for `getFileBlob`.
 *
 * - Leading `/` (root-relative) → strip the slash; resolve from context root.
 * - Leading `./` (explicit-relative) → strip it; `getFileBlob` only strips
 *   leading `/`, so a literal `./x.png` would 404 — especially in chat where
 *   `baseDir` is null.
 * - Otherwise (relative) → join against `baseDir` when present.
 * - `.` / `..` segments are collapsed (`docs` + `../assets/x.png` →
 *   `assets/x.png`); `..` never climbs above the context root.
 *
 * Returns the path to pass to `api.getFileBlob`.
 */
export function resolveImagePath(src: string, baseDir: string | null): string {
  // Root-relative: resolve from the context root (baseDir is NOT applied).
  const joined = src.startsWith("/") ? src : baseDir ? `${baseDir}/${src}` : src;
  const out: string[] = [];
  for (const seg of joined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}
