import {
  $getNodeByKey,
  $getSelection,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $nodesOfType,
  $createTextNode,
  type LexicalEditor,
  type NodeKey,
  type TextNode,
} from "lexical";
import type { Mention } from "@/api/types";
import { $createMentionChipNode, MentionChipNode } from "@/lexical/MentionChipNode";
import { isLeftBoundary, safeMentionLabel } from "@/lib/mentions";

export const MAX_MENTION_QUERY_LENGTH = 80;

function isAtBoundary(node: TextNode, atIndexInNode: number): boolean {
  if (atIndexInNode > 0) {
    return isLeftBoundary(node.getTextContent().slice(0, atIndexInNode));
  }
  const prev = node.getPreviousSibling();
  if (prev === null) return true; // start of block
  if ($isLineBreakNode(prev)) return true;
  if ($isTextNode(prev)) {
    const t = prev.getTextContent();
    return isLeftBoundary(t);
  }
  return false;
}

export function $findActiveAtToken(): { raw: string; nodeKey: NodeKey; start: number } | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const anchor = selection.anchor;
  if (anchor.type !== "text") return null;
  const node = anchor.getNode();
  if (!$isTextNode(node)) return null;
  const text = node.getTextContent().slice(0, anchor.offset);
  // The query may contain spaces (multi-word names/paths); tabs, newlines and
  // a second `@` terminate it. It must not start with whitespace and is capped.
  const m = /@([^\t\r\n@]*)$/.exec(text);
  if (!m) return null;
  const query = m[1] ?? "";
  if (query.length > MAX_MENTION_QUERY_LENGTH || /^\s/.test(query)) return null;
  const atIndex = anchor.offset - m[0].length;
  if (!isAtBoundary(node, atIndex)) return null;
  return { raw: m[1] ?? "", nodeKey: node.getKey(), start: atIndex };
}

export function countMentions(): number {
  return $nodesOfType(MentionChipNode).length;
}

export function insertMentionForActiveToken(
  editor: LexicalEditor,
  mention: Mention,
): void {
  editor.update(() => {
    const found = $findActiveAtToken();
    if (!found) return;
    const node = $getNodeByKey(found.nodeKey);
    if (!$isTextNode(node)) return;
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
    const end = selection.anchor.offset;
    const parts = node.splitText(found.start, end);
    const middle = parts[found.start > 0 ? 1 : 0];
    if (!middle) return;

    const chip = $createMentionChipNode({
      ...mention,
      label: safeMentionLabel(mention),
    });
    middle.replace(chip);
    const space = $createTextNode(" ");
    chip.insertAfter(space);
    space.select(1, 1);
  });
}

export function rewriteActiveAtToken(
  editor: LexicalEditor,
  nextText: string,
): void {
  editor.update(() => {
    const found = $findActiveAtToken();
    if (!found) return;
    const node = $getNodeByKey(found.nodeKey);
    if (!$isTextNode(node)) return;
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
    const end = selection.anchor.offset;
    const parts = node.splitText(found.start, end);
    const middle = parts[found.start > 0 ? 1 : 0];
    if (!middle) return;

    const newTextNode = $createTextNode(nextText);
    middle.replace(newTextNode);
    newTextNode.select(nextText.length, nextText.length);
  });
}
