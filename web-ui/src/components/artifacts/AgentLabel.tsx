import { BotOff } from "lucide-react";
import type { Session } from "@/api/types";
import { SessionModeIcon } from "@/components/agent/SessionModeIcon";
import { sessionLabel } from "@/lib/sessionLabel";
import { DELETED_AGENT_LABEL } from "./artifactSessions";

interface AgentLabelProps {
  /** The agent, or null for a writer whose session no longer exists. */
  session: Session | null;
  /** Glyph size in px (the sidebar agent rows use 13). */
  size?: number;
  className?: string;
  /** Tooltip; defaults to the agent's name. */
  title?: string;
}

/**
 * An agent as the sidebar shows it: its mode icon (terminal frame for tmux agents) and its name. The owning surface
 * (`ArtifactsList`, `ArtifactStripItems`) loads the modes once via `useModesSync`.
 */
export function AgentLabel({ session, size = 12, className, title }: AgentLabelProps) {
  const classes = ["artifacts-agent", session ? null : "artifacts-agent--deleted", className].filter(Boolean).join(" ");
  if (!session) {
    return (
      <span className={classes} title={title}>
        <BotOff size={size} aria-hidden="true" className="artifacts-agent__deleted-icon" />
        <span className="artifacts-agent__name">{DELETED_AGENT_LABEL}</span>
      </span>
    );
  }
  const label = sessionLabel(session);
  return (
    <span className={classes} title={title ?? label}>
      <SessionModeIcon session={session} size={size} className="artifacts-agent__icon" />
      <span className="artifacts-agent__name">{label}</span>
    </span>
  );
}

