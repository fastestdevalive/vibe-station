import { Pin } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { ArtifactRow } from "@/api/types";
import { Chip } from "@/components/ui/Chip";
import { useServerStore } from "@/hooks/useServerStore";
import { writerLabel } from "./artifactSessions";
import "./artifacts.css";
import { toggleArtifactPin } from "./artifactActions";

type StripApi = Pick<ApiInstance, "pinArtifact">;

interface ArtifactStripItemsProps {
  api: StripApi;
  scopeId: string;
  row: ArtifactRow;
}

/**
 * The artifact-specific tail of the preview strip (`Main.dc.html` `.vstrip`): spacer, writer chip, the
 * `outside repo` warn chip and the pin toggle. NO Copy path button (it stays in the row menu and the
 * state panels). The Comment button is rendered by `FilePreviewPane` (`CommentStripButton`), not here.
 */
export function ArtifactStripItems({ api, scopeId, row }: ArtifactStripItemsProps) {
  const sessions = useServerStore((s) => s.sessions);
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const writer = writerLabel(row, byId);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const flash = (text: string) => {
    setNote(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(null), 4000);
  };

  const togglePin = async () => {
    const note = await toggleArtifactPin(api, scopeId, row);
    if (note) flash(note);
  };

  return (
    <>
      <span className="artifact-strip__spacer" />
      {note ? (
        <span className="artifact-strip__note" role="status">
          {note}
        </span>
      ) : null}
      {writer ? (
        <Chip size="md" title={`Written by ${writer}`}>
          {writer}
        </Chip>
      ) : null}
      {!row.inRepo ? (
        <Chip size="md" tone="warn">
          outside repo
        </Chip>
      ) : null}
      <button
        type="button"
        className="artifact-strip__pin"
        aria-pressed={row.pinned}
        aria-label={row.pinned ? "Unpin" : "Pin"}
        title={row.pinned ? "Unpin" : "Pin"}
        onClick={() => void togglePin()}
      >
        <Pin size={14} aria-hidden="true" className={row.pinned ? "artifact-strip__pin-icon--on" : undefined} />
      </button>
    </>
  );
}
