import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getAdjacentNode,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
} from "lexical";
import { useEffect } from "react";
import { $isMentionChipNode } from "./MentionChipNode";

export function MentionChipKeysPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const unregisterFns = [
      editor.registerCommand(
        KEY_BACKSPACE_COMMAND,
        (event) => {
          if (event?.isComposing) return false;
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
          const node = $getAdjacentNode(selection.focus, true);
          if (!$isMentionChipNode(node)) return false;
          event?.preventDefault();
          node.remove();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_DELETE_COMMAND,
        (event) => {
          if (event?.isComposing) return false;
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
          const node = $getAdjacentNode(selection.focus, false);
          if (!$isMentionChipNode(node)) return false;
          event?.preventDefault();
          node.remove();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ARROW_LEFT_COMMAND,
        (event) => {
          if (event?.isComposing) return false;
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
          const node = $getAdjacentNode(selection.focus, true);
          if (!$isMentionChipNode(node)) return false;
          event?.preventDefault();
          node.selectPrevious();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ARROW_RIGHT_COMMAND,
        (event) => {
          if (event?.isComposing) return false;
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
          const node = $getAdjacentNode(selection.focus, false);
          if (!$isMentionChipNode(node)) return false;
          event?.preventDefault();
          node.selectNext(0, 0);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    ];

    return () => {
      unregisterFns.forEach((fn) => fn());
    };
  }, [editor]);

  return null;
}
