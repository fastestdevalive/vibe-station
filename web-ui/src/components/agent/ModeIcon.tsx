import type { Channel } from "@/api/types";
import type { ReactNode } from "react";
import claudeSvg from "@/assets/mode-icons/claude.svg?raw";
import agySvg from "@/assets/mode-icons/agy.svg?raw";
import opencodeSvg from "@/assets/mode-icons/opencode.svg?raw";
import deepseekSvg from "@/assets/mode-icons/deepseek.svg?raw";
import cursorSvg from "@/assets/mode-icons/cursor.svg?raw";
import "@/styles/mode-icon.css";

/** Trusted repo assets, imported as raw SVG strings and inlined so glyphs that
 *  use `currentColor` (opencode, cursor) inherit the theme colour. */
const ICONS: Record<string, string> = {
  claude: claudeSvg,
  agy: agySvg,
  opencode: opencodeSvg,
  deepseek: deepseekSvg,
  cursor: cursorSvg,
};

const FALLBACK_GLYPH = "◈";

interface ModeIconProps {
  /** Icon key (`claude|agy|opencode|deepseek|cursor`); unknown/null → generic fallback. */
  iconKey?: string | null;
  /** Execution channel. `json` (Rich Chat) renders the icon bare; terminal
   *  channels (`tmux`/`pty`/undefined) wrap it in a rounded terminal frame. */
  channel?: Channel;
  /** Pixel size of the icon glyph (default 14). The frame scales around it. */
  size?: number;
  /** Optional label for screen readers (defaults to the icon key). */
  label?: string;
}

export function ModeIcon({ iconKey, channel, size = 14, label }: ModeIconProps) {
  const isTerminal = channel !== "json";
  const raw = iconKey && Object.hasOwn(ICONS, iconKey) ? ICONS[iconKey] : undefined;

  const glyph: ReactNode = raw ? (
    <span
      className="mode-icon__glyph"
      style={{ width: size, height: size }}
      // dangerouslySetInnerHTML: the SVG strings are trusted repo assets
      // imported with `?raw`, not user input.
      dangerouslySetInnerHTML={{ __html: raw }}
    />
  ) : (
    <span
      className="mode-icon__glyph mode-icon__glyph--fallback"
      style={{ width: size, height: size, fontSize: size }}
      aria-hidden="true"
    >
      {FALLBACK_GLYPH}
    </span>
  );

  const accessibleLabel = label ?? iconKey ?? "unknown mode";
  // Only an explicitly labelled icon gets a tooltip: decorative tab/chip/card
  // icons must not shadow the surrounding element's own title (the full name).
  const title = label;

  if (isTerminal) {
    return (
      <span
        className="mode-icon mode-icon--terminal"
        role="img"
        aria-label={accessibleLabel}
        title={title}
      >
        <span className="mode-icon__dots" aria-hidden="true">
          <span className="mode-icon__dot" />
          <span className="mode-icon__dot" />
          <span className="mode-icon__dot" />
        </span>
        {glyph}
      </span>
    );
  }

  return (
    <span className="mode-icon" role="img" aria-label={accessibleLabel} title={title}>
      {glyph}
    </span>
  );
}
