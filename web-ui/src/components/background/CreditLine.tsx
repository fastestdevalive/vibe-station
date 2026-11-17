import type { WallpaperEntry } from "@/api/types";
import { openExternal } from "@/lib/openExternal";
import "./picker.css";

function hostOf(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url === "") return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * One-line credit for a wallpaper: `name · author · CC0`, or `name · via
 * rawpixel · CC0` when the catalog lists no author but the source is rawpixel,
 * or just `name · CC0` when neither is known. Always one line, never empty.
 * The author segment links to the source page (`openExternal`).
 */
export function CreditLine({ entry }: { entry: WallpaperEntry }): React.JSX.Element {
  const license = entry.license !== null && entry.license !== undefined && entry.license !== ""
    ? entry.license
    : "CC0";
  const author = entry.author !== null && entry.author !== undefined && entry.author !== ""
    ? entry.author
    : null;
  const who = author ?? (hostOf(entry.sourcePage)?.includes("rawpixel") ? "via rawpixel" : null);
  const sourcePage = entry.sourcePage ?? null;

  return (
    <p className="wp-credit">
      <span>{entry.name}</span>
      {who !== null ? (
        <>
          {" · "}
          {sourcePage !== null ? (
            <button
              type="button"
              className="wp-credit__link"
              onClick={() => openExternal(sourcePage)}
            >
              {who}
            </button>
          ) : (
            <span>{who}</span>
          )}
        </>
      ) : null}
      {" · "}
      {license}
    </p>
  );
}
