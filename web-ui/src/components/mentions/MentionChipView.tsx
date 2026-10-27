import type { Mention } from "@/api/types";
import { mentionKindDef } from "./kinds";

export interface MentionChipViewProps {
  mention: Mention;
}

export function MentionChipView({ mention }: MentionChipViewProps) {
  const def = mentionKindDef(mention.kind);
  const Icon = def.Icon;
  const title = mention.kind === "file" ? mention.id : mention.label;

  return (
    <span
      className="chat-mention-chip"
      title={title}
      data-kind={mention.kind}
      data-mention-id={mention.id}
    >
      <Icon size={12} aria-hidden />
      <span className="chat-mention-chip__label">{mention.label}</span>
    </span>
  );
}
