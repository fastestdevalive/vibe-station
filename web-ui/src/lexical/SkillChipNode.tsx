import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createTextNode,
  $getNodeByKey,
  DecoratorNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { createContext, useContext } from "react";
import type { Command } from "@/api/types";
import { SkillInvocationRow } from "@/components/chat/SkillInvocationRow";

/**
 * Phase 7B.3 — the skill-invocation chip as an atomic, inline Lexical
 * `DecoratorNode`: one document position per chip, args held as NODE STATE
 * (not document text), rendered via the salvaged `SkillInvocationRow`.
 */

export type SerializedSkillChipNode = Spread<
  { skillName: string; skillArgs: string },
  SerializedLexicalNode
>;

/** Per-`<SkillEditor>` context: the catalog (for the arg placeholder), the
 *  live map of nodeKey -> arg `<input>` DOM node (read by the editor's own
 *  caret-adjacency plugin to move focus INTO a chip from outside it), and
 *  the Ctrl/Cmd+Enter escape hatch to the mount site's send/save action. */
export interface SkillChipContextValue {
  commands: Command[];
  inputRefs: Map<NodeKey, HTMLInputElement>;
  onCtrlEnter: () => void;
}
export const SkillChipContext = createContext<SkillChipContextValue | null>(null);

export class SkillChipNode extends DecoratorNode<React.ReactElement> {
  __name: string;
  __args: string;

  static override getType(): string {
    return "skill-chip";
  }

  static override clone(node: SkillChipNode): SkillChipNode {
    return new SkillChipNode(node.__name, node.__args, node.__key);
  }

  static override importJSON(serialized: SerializedSkillChipNode): SkillChipNode {
    return new SkillChipNode(serialized.skillName, serialized.skillArgs);
  }

  override exportJSON(): SerializedSkillChipNode {
    return {
      ...super.exportJSON(),
      type: "skill-chip",
      version: 1,
      skillName: this.__name,
      skillArgs: this.__args,
    };
  }

  constructor(name: string, args: string, key?: NodeKey) {
    super(key);
    this.__name = name;
    this.__args = args;
  }

  override createDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "chat-skill-chip-host";
    return span;
  }

  override updateDOM(): boolean {
    return false;
  }

  override isInline(): boolean {
    return true;
  }

  override getTextContent(): string {
    // Never used for wire serialization (SkillEditor walks the tree itself
    // to produce the brace-token string), but a sane fallback for anything
    // that calls the generic Lexical text-extraction path (e.g. copy).
    return this.__args ? `/${this.__name} ${this.__args}` : `/${this.__name}`;
  }

  getName(): string {
    return this.__name;
  }

  getArgs(): string {
    return this.__args;
  }

  setArgs(args: string): void {
    const self = this.getWritable();
    self.__args = args;
  }

  override decorate(): React.ReactElement {
    return <SkillChipComponent nodeKey={this.getKey()} name={this.__name} args={this.__args} />;
  }
}

export function $createSkillChipNode(name: string, args: string): SkillChipNode {
  return new SkillChipNode(name, args);
}

export function $isSkillChipNode(node: LexicalNode | null | undefined): node is SkillChipNode {
  return node instanceof SkillChipNode;
}

/** Hand DOM focus back to the contenteditable root.
 *
 *  `editor.focus()` alone is NOT enough here: a chip's arg `<input>` lives
 *  INSIDE the editor root's DOM subtree, so while it holds focus Lexical
 *  already considers itself focused and the call is a no-op — the caret stays
 *  trapped in the arg input and everything the user types afterwards goes into
 *  the arguments instead of the prose. Focus the root element directly. */
function focusEditorRoot(editor: LexicalEditor): void {
  const root = editor.getRootElement();
  const active = document.activeElement;
  // Only steal focus when it is currently trapped on a node INSIDE the editor
  // (i.e. a chip's arg input). If focus is anywhere else, `editor.focus()`
  // alone is correct and sufficient — and calling `root.focus()` there would
  // reset the selection Lexical just placed.
  if (root && active && active !== root && root.contains(active)) {
    root.focus({ preventScroll: true });
  }
  editor.focus();
}

/** Move Lexical's own selection to just after `nodeKey` and hand DOM focus
 *  back to the contenteditable root — the chip's arg input exiting rightwards
 *  (Enter, or → at end of args). */
export function $moveSelectionAfterChip(editor: LexicalEditor, nodeKey: NodeKey): void {
  editor.update(
    () => {
      const node = $getNodeByKey(nodeKey);
      if (node) node.selectNext(0, 0);
    },
    { onUpdate: () => focusEditorRoot(editor) },
  );
}

/** Move Lexical's own selection to just before `nodeKey`. */
export function $moveSelectionBeforeChip(editor: LexicalEditor, nodeKey: NodeKey): void {
  editor.update(
    () => {
      const node = $getNodeByKey(nodeKey);
      if (node) node.selectPrevious();
    },
    { onUpdate: () => focusEditorRoot(editor) },
  );
}

/** Progressive-backspace collapse (spec correction): remove the chip and
 *  replace it with a literal `/`, caret right after it — the general
 *  typeahead detector (driven off the editor's own update listener) then
 *  reopens the popover exactly as if the user had just typed `/`, so they
 *  can pick a different skill. */
export function $collapseChipToSlash(editor: LexicalEditor, nodeKey: NodeKey): void {
  editor.update(() => {
    const node = $getNodeByKey(nodeKey);
    if (!$isSkillChipNode(node)) return;
    const textNode = $createTextNode("/");
    node.replace(textNode);
    textNode.select(1, 1);
  });
}

function SkillChipComponent({ nodeKey, name, args }: { nodeKey: NodeKey; name: string; args: string }) {
  const [editor] = useLexicalComposerContext();
  const ctx = useContext(SkillChipContext);
  const argumentHint = ctx?.commands.find((c) => c.name === name)?.argumentHint;

  return (
    <SkillInvocationRow
      ref={(el) => {
        if (!ctx) return;
        if (el) ctx.inputRefs.set(nodeKey, el);
        else ctx.inputRefs.delete(nodeKey);
      }}
      prefix={{ name, args }}
      argumentHint={argumentHint}
      onArgsChange={(nextArgs) => {
        editor.update(() => {
          const node = $getNodeByKey(nodeKey);
          if ($isSkillChipNode(node)) node.setArgs(nextArgs);
        });
      }}
      onCollapseToSlash={() => $collapseChipToSlash(editor, nodeKey)}
      onExitToProse={() => $moveSelectionAfterChip(editor, nodeKey)}
      onExitToProseBefore={() => $moveSelectionBeforeChip(editor, nodeKey)}
      onCtrlEnter={() => ctx?.onCtrlEnter()}
    />
  );
}
