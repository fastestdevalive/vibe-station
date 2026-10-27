import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import type { Mention, MentionKind } from "@/api/types";
import { MentionChipView } from "@/components/mentions/MentionChipView";
import { mentionPlainText } from "@/lib/mentions";

export type SerializedMentionChipNode = Spread<
  { kind: MentionKind; id: string; label: string },
  SerializedLexicalNode
>;

export class MentionChipNode extends DecoratorNode<React.ReactElement> {
  __mention: Mention;

  static override getType(): string {
    return "mention-chip";
  }

  static override clone(node: MentionChipNode): MentionChipNode {
    return new MentionChipNode(node.__mention, node.__key);
  }

  static override importJSON(serialized: SerializedMentionChipNode): MentionChipNode {
    // Tolerate payloads from newer/older clients: an unknown kind is kept
    // as-is (renders a generic chip); non-string fields degrade to "".
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    return new MentionChipNode({
      kind: serialized.kind,
      id: str(serialized.id),
      label: str(serialized.label),
    });
  }

  override exportJSON(): SerializedMentionChipNode {
    return {
      ...super.exportJSON(),
      type: "mention-chip",
      version: 1,
      kind: this.__mention.kind,
      id: this.__mention.id,
      label: this.__mention.label,
    };
  }

  constructor(mention: Mention, key?: NodeKey) {
    super(key);
    this.__mention = mention;
  }

  override createDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "chat-mention-chip-host";
    return span;
  }

  override updateDOM(): boolean {
    return false;
  }

  override isInline(): boolean {
    return true;
  }

  override isKeyboardSelectable(): boolean {
    return false;
  }

  override getTextContent(): string {
    return mentionPlainText(this.getMention());
  }

  getMention(): Mention {
    return this.__mention;
  }

  override decorate(): React.ReactElement {
    return <MentionChipView mention={this.getMention()} />;
  }
}

export function $createMentionChipNode(mention: Mention): MentionChipNode {
  return new MentionChipNode(mention);
}

export function $isMentionChipNode(node: LexicalNode | null | undefined): node is MentionChipNode {
  return node instanceof MentionChipNode;
}
