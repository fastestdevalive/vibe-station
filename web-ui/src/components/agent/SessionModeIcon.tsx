import type { Session } from "@/api/types";
import { sessionModeId } from "@/lib/modeIcon";
import { useModeIcon, type ModesApi } from "@/store/modesStore";
import { ModeIcon } from "./ModeIcon";

interface SessionModeIconProps {
  session: Session;
  /**
   * Loads the modes and keeps them live while mounted. Omit it where the owning surface already calls
   * `useModesSync(api)` once (a list of many icons); the session's `modeIcon` snapshot wins either way.
   */
  api?: ModesApi;
  size?: number;
  className?: string;
}

/** Decorative mode icon of one session (terminal frame for tmux agents); the adjacent name carries the label. */
export function SessionModeIcon({ session, api, size = 13, className }: SessionModeIconProps) {
  const iconKey = useModeIcon(sessionModeId(session), api, session.modeIcon);
  return (
    <span className={className} aria-hidden="true">
      <ModeIcon iconKey={iconKey} channel={session.channel} size={size} />
    </span>
  );
}
