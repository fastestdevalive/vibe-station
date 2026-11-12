import {
  Bot,
  Check,
  Circle,
  CircleAlert,
  CircleHelp,
  GitCommitHorizontal,
  MessageSquareText,
  SeparatorHorizontal,
  type LucideIcon,
} from "lucide-react";
import type { Beat, BeatKind } from "./buildTurnBeats";
import { beatSpokenLabel } from "./buildTurnBeats";
import { formatOutlineSpokenTime } from "@/lib/timeAgo";
import { type PanelMode, type TreeFocus, outlineBeatId } from "./outlineTree";
import { OutlineTime } from "./OutlineTime";

const BEAT_ICON: Record<BeatKind, LucideIcon> = {
  text: MessageSquareText,
  error: CircleAlert,
  ask: CircleHelp,
  commit: GitCommitHorizontal,
  subagent: Bot,
  todo: Check,
  break: SeparatorHorizontal,
};

/** One 14px stroke glyph per beat kind; the live step is a filled working dot. */
function BeatGlyph({ kind, live }: { kind: BeatKind; live: boolean }) {
  const Icon = live ? Circle : BEAT_ICON[kind];
  return (
    <span className="olp__gl" aria-hidden="true">
      <Icon size={14} strokeWidth={1.5} fill={live ? "currentColor" : "none"} />
    </span>
  );
}

export interface BeatRowsProps {
  outlineId: string;
  nodeKey: string;
  beats: Beat[];
  /** The owning turn's timestamp: a same-day beat of an old turn shows only its time. */
  turnTs?: string;
  /** For the spoken age in the aria-labels. */
  now: number;
  isLive: boolean;
  mode: PanelMode;
  marked: TreeFocus | null;
  newBeatKeys: ReadonlySet<string>;
  currentHitAnchor?: string;
  onJump: (anchor: string) => void;
  onClose: () => void;
}

export function BeatRows({
  outlineId,
  nodeKey,
  beats,
  turnTs,
  now,
  isLive,
  mode,
  marked,
  newBeatKeys,
  currentHitAnchor,
  onJump,
  onClose,
}: BeatRowsProps) {
  if (beats.length === 0) return null;

  return (
    <div role="none" className="olp__beats">
      {beats.map((b, k) => {
        const live = isLive && k === beats.length - 1;
        let cls = `olp__beat k-${live ? "live" : b.kind}`;
        if (k === beats.length - 1) cls += " last";
        if (mode === "keyboard" && marked?.turnKey === nodeKey && marked.beat === k) cls += " kfocus";
        if (mode !== "keyboard" && marked?.turnKey === nodeKey && marked.beat === k) cls += " scrub";
        if (newBeatKeys.has(b.key)) cls += " new";
        if (currentHitAnchor && b.anchor === currentHitAnchor) cls += " find-cur";

        const spokenTime = formatOutlineSpokenTime(b.ts, now);
        return (
          <div role="none" key={b.key}>
            <button
              type="button"
              role="treeitem"
              aria-level={2}
              aria-setsize={beats.length}
              aria-posinset={k + 1}
              aria-label={spokenTime ? `${beatSpokenLabel(b)}, ${spokenTime}` : beatSpokenLabel(b)}
              id={outlineBeatId(outlineId, nodeKey, k)}
              className={cls}
              title={b.label}
              onClick={() => {
                onJump(b.anchor);
                onClose();
              }}
            >
              <BeatGlyph kind={b.kind} live={live} />
              <span className="olp__label">{b.label}</span>
              {b.count > 1 && <span className="olp__plus">+{b.count - 1}</span>}
              <OutlineTime ts={b.ts} tsEnd={b.count > 1 ? b.tsEnd : undefined} parentTs={turnTs} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
