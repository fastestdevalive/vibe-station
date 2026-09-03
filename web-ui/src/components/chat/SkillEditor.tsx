import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getAdjacentNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $isLineBreakNode,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH,
  COPY_COMMAND,
  CUT_COMMAND,
  INSERT_LINE_BREAK_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  PASTE_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type RangeSelection,
  type TextNode,
} from "lexical";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Command } from "@/api/types";
import { escapeSkillArgs, escapeSkillText, filterCommands, parseSkillSegments } from "@/lib/skillInvocation";
import {
  $createSkillChipNode,
  $isSkillChipNode,
  SkillChipContext,
  SkillChipNode,
} from "@/lexical/SkillChipNode";
import { SkillPopover } from "./SkillPopover";

/** Grow the editor up to this many lines of content, then scroll internally
 *  — enforced purely via CSS (`max-height` + `overflow-y: auto`) since a
 *  contenteditable autosizes its own height natively; no JS measurement
 *  loop needed (Phase 7B.8, replaces `autosizeComposerTextarea`). */
export const COMPOSER_MAX_GROW_LINES = 10;

/** Private clipboard MIME carrying the raw `{/name args}` wire fragment for
 *  a copied/cut range — read back on paste so an in-app paste restores real
 *  chips (spec §6). `text/plain` always carries the human-readable
 *  `/name args` form instead (never the brace syntax — braces are never
 *  user-facing). */
const SKILL_CLIPBOARD_MIME = "application/x-vst-skill-tokens";

export interface SkillEditorHandle {
  /** The current content, serialized to the flat `{/name args}` brace
   *  string (Decision 2) — what `useComposerDraft`/the send payload want. */
  getText: () => string;
  /** Reset to empty and refocus — called after a successful send. */
  clear: () => void;
  focus: () => void;
}

interface SkillEditorProps {
  /** Stable per-mount identity for the Lexical namespace; also forces a
   *  fresh editor (and thus a fresh `initialText` seed) on change, mirroring
   *  the old `useState(() => ...)` lazy-init-once mount contract. */
  editorKey: string;
  /** Seed content — the flat brace-token string (already migrated from any
   *  v1 draft by the caller). Read once, at mount. */
  initialText: string;
  /** Session's slash-command/skill catalog. `undefined` — not yet loaded —
   *  disables the popover entirely (Requirement 11 parity). */
  commands?: Command[];
  disabled?: boolean;
  ariaLabel: string;
  placeholder?: string;
  className: string;
  /** Fires on every content change with the serialized string and whether
   *  the editor currently "has content" (Phase 7B.9: any chip node present
   *  OR non-empty text). */
  onChangeText: (text: string, hasContent: boolean) => void;
  /** Plain Enter (no popover open, no modifiers) or Ctrl/Cmd+Enter anywhere
   *  (including inside a chip's arg input) — the mount site's send/save. */
  onSubmit: () => void;
  /** Escape with no popover open — QueuedTurnEditor's discard; Composer
   *  passes nothing. */
  onEscape?: () => void;
  /** Whether a chip's arg input currently has focus — swaps the hint line. */
  onArgFocusChange?: (focused: boolean) => void;
}

const EDITOR_NODES = [SkillChipNode];

function onLexicalError(error: Error): void {
  console.error("[SkillEditor]", error);
}

/** Build the initial single-paragraph node tree from a brace-token string. */
function seedEditorState(initialText: string) {
  return (editor: LexicalEditor) => {
    editor.update(
      () => {
        const root = $getRoot();
        if (root.getChildrenSize() > 0) return;
        const paragraph = $createParagraphNode();
        const segments = parseSkillSegments(initialText);
        for (const seg of segments) {
          if (seg.type === "token") {
            paragraph.append($createSkillChipNode(seg.name, seg.args));
            continue;
          }
          const lines = seg.text.split("\n");
          lines.forEach((line, i) => {
            if (i > 0) paragraph.append($createLineBreakNode());
            if (line.length > 0) paragraph.append($createTextNode(line));
          });
        }
        root.append(paragraph);
      },
      { tag: "skill-editor-seed" },
    );
  };
}

/** Serialize the current editor state back to the flat brace-token string —
 *  the inverse of `seedEditorState`. Blocks (paragraphs) join with `\n`;
 *  within a block, `LineBreakNode`s also serialize to a literal `\n` — both
 *  are ordinary characters in the grammar (Decision 2 only assigns meaning
 *  to `\`/`{`/`}`). */
function serializeEditor(editor: LexicalEditor): { text: string; hasChip: boolean; hasText: boolean } {
  return editor.getEditorState().read(() => {
    let hasChip = false;
    let hasText = false;
    const blocks = $getRoot()
      .getChildren()
      .map((block) => {
        if (!$isElementNode(block)) return "";
        return block
          .getChildren()
          .map((node) => {
            if ($isSkillChipNode(node)) {
              hasChip = true;
              const args = node.getArgs();
              return args.length > 0 ? `{/${node.getName()} ${escapeSkillArgs(args)}}` : `{/${node.getName()}}`;
            }
            if ($isLineBreakNode(node)) return "\n";
            if ($isTextNode(node)) {
              const raw = node.getTextContent();
              if (/\S/.test(raw)) hasText = true;
              return escapeSkillText(raw);
            }
            return "";
          })
          .join("");
      });
    return { text: blocks.join("\n"), hasChip, hasText };
  });
}

function isWhitespaceChar(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/**
 * Spec §4: `/` opens the popover ONLY at document start, or immediately
 * preceded by whitespace — never inside a word (`and/or`, `http://x`,
 * `src/foo`). `slashIndexInNode` is the `/`'s offset WITHIN `node`'s own
 * text; when it's 0 the boundary check has to look at what precedes `node`
 * itself (a previous sibling in the same block, or the start of the block).
 */
function $isSlashBoundary(node: TextNode, slashIndexInNode: number): boolean {
  if (slashIndexInNode > 0) {
    return isWhitespaceChar(node.getTextContent()[slashIndexInNode - 1]);
  }
  const prev = node.getPreviousSibling();
  if (prev === null) return true; // start of this block counts as a boundary
  if ($isLineBreakNode(prev)) return true;
  if ($isSkillChipNode(prev)) return false; // "chip/" — not a boundary
  if ($isTextNode(prev)) {
    const t = prev.getTextContent();
    return t.length === 0 || isWhitespaceChar(t[t.length - 1]);
  }
  return false;
}

/** The live `/query` run ending at the caret, if any, honoring the §4 word-
 *  boundary rule — returns its identity (`nodeKey` + start offset within
 *  that node) so callers can track "the same token" across edits (Escape
 *  suppression) or locate it again to materialize a chip. */
function $findActiveSlashToken(): { query: string; nodeKey: NodeKey; start: number } | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const anchor = selection.anchor;
  if (anchor.type !== "text") return null;
  const node = anchor.getNode();
  if (!$isTextNode(node)) return null;
  const text = node.getTextContent().slice(0, anchor.offset);
  const m = /\/(\S*)$/.exec(text);
  if (!m) return null;
  const slashIndex = anchor.offset - m[0].length;
  if (!$isSlashBoundary(node, slashIndex)) return null;
  return { query: m[1] ?? "", nodeKey: node.getKey(), start: slashIndex };
}

/** Replace the live `/query` text run ending at the caret with a skill chip
 *  (popover selection). */
function insertChipForActiveToken(
  editor: LexicalEditor,
  name: string,
  /** Focus the new chip's arg input once the DOM for it exists. Picking a
   *  skill must land the caret IN the arg slot — otherwise the args the user
   *  immediately types become prose after the chip (they serialize as
   *  `{/name}args`, which the daemon then substitutes as `/nameargs`). */
  focusArgInput?: (nodeKey: NodeKey) => void,
): void {
  let chipKey: NodeKey | null = null;
  editor.update(
    () => {
      const found = $findActiveSlashToken();
      if (!found) return;
      const node = $getNodeByKey(found.nodeKey);
      if (!$isTextNode(node)) return;
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
      const end = selection.anchor.offset;
      const parts = node.splitText(found.start, end);
      const middle = parts[found.start > 0 ? 1 : 0];
      if (!middle) return;
      const chip = $createSkillChipNode(name, "");
      middle.replace(chip);
      chip.selectNext(0, 0);
      chipKey = chip.getKey();
    },
    {
      onUpdate: () => {
        // The decorator's React subtree mounts after this update commits, so
        // its <input> is not in `inputRefs` yet — defer one frame.
        if (chipKey && focusArgInput) {
          const key = chipKey;
          requestAnimationFrame(() => focusArgInput(key));
          return;
        }
        editor.focus();
      },
    },
  );
}

/** Serialize a (possibly partial-node) selection to the raw brace-token wire
 *  fragment, for the private clipboard type (spec §6). Text-node boundaries
 *  are sliced to the selection's own offsets; any other selected node type
 *  is taken whole (a defensible approximation — this editor's document is
 *  always `(text | LineBreak | SkillChip)*`). */
function $serializeSelectionTokens(selection: RangeSelection): string {
  const nodes = selection.getNodes();
  if (nodes.length === 0) return "";
  const isBackward = selection.isBackward();
  const firstPoint = isBackward ? selection.focus : selection.anchor;
  const lastPoint = isBackward ? selection.anchor : selection.focus;
  const firstKey = firstPoint.type === "text" ? firstPoint.getNode().getKey() : null;
  const lastKey = lastPoint.type === "text" ? lastPoint.getNode().getKey() : null;
  return nodes
    .map((node) => {
      if ($isSkillChipNode(node)) {
        const args = node.getArgs();
        return args.length > 0 ? `{/${node.getName()} ${escapeSkillArgs(args)}}` : `{/${node.getName()}}`;
      }
      if ($isLineBreakNode(node)) return "\n";
      if ($isTextNode(node)) {
        let text = node.getTextContent();
        const isFirst = node.getKey() === firstKey;
        const isLast = node.getKey() === lastKey;
        if (isFirst && isLast) text = text.slice(firstPoint.offset, lastPoint.offset);
        else if (isFirst) text = text.slice(firstPoint.offset);
        else if (isLast) text = text.slice(0, lastPoint.offset);
        return escapeSkillText(text);
      }
      return "";
    })
    .join("");
}

/** Nodes to insert for a parsed segment list — shared by paste-reconstruction. */
function segmentsToNodes(segments: ReturnType<typeof parseSkillSegments>): LexicalNode[] {
  const nodes: LexicalNode[] = [];
  for (const seg of segments) {
    if (seg.type === "token") {
      nodes.push($createSkillChipNode(seg.name, seg.args));
      continue;
    }
    const lines = seg.text.split("\n");
    lines.forEach((line, i) => {
      if (i > 0) nodes.push($createLineBreakNode());
      if (line.length > 0) nodes.push($createTextNode(line));
    });
  }
  return nodes;
}

/** Adjacency + keymap + clipboard plugin: everything that needs the editor
 *  instance and Lexical command registration (caret contract, Enter/Escape/
 *  newline, popover keyboard nav, copy/cut/paste). Rendered as a child of
 *  `<LexicalComposer>`. */
function SkillEditorPlugin({
  inputRefs,
  onSubmit,
  onEscape,
  popoverStateRef,
  selectActivePopoverItem,
  closePopover,
  setActiveIndex,
  popoverItemsRef,
  suppressedTokenRef,
  pasteSuppressRef,
}: {
  inputRefs: Map<NodeKey, HTMLInputElement>;
  onSubmit: () => void;
  onEscape?: () => void;
  popoverStateRef: React.MutableRefObject<boolean>;
  selectActivePopoverItem: () => void;
  closePopover: () => void;
  setActiveIndex: (updater: (i: number) => number) => void;
  popoverItemsRef: React.MutableRefObject<Command[]>;
  suppressedTokenRef: React.MutableRefObject<{ nodeKey: NodeKey; start: number } | null>;
  pasteSuppressRef: React.MutableRefObject<boolean>;
}) {
  const [editor] = useLexicalComposerContext();
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    function focusChipInput(nodeKey: NodeKey, atStart: boolean) {
      const el = inputRefs.get(nodeKey);
      if (!el) return;
      el.focus();
      const pos = atStart ? 0 : el.value.length;
      el.setSelectionRange(pos, pos);
    }

    const unregisterFns = [
      // §1: → from before-chip enters the arg input at start.
      editor.registerCommand(
        KEY_ARROW_RIGHT_COMMAND,
        (event) => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
          const node = $getAdjacentNode(selection.focus, false);
          if (!$isSkillChipNode(node)) return false;
          event?.preventDefault();
          focusChipInput(node.getKey(), true);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      // §1: ← from after-chip enters the arg input at end.
      editor.registerCommand(
        KEY_ARROW_LEFT_COMMAND,
        (event) => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
          const node = $getAdjacentNode(selection.focus, true);
          if (!$isSkillChipNode(node)) return false;
          event?.preventDefault();
          focusChipInput(node.getKey(), false);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      // §2: Backspace right of a chip enters the arg input at end, deletes nothing.
      editor.registerCommand(
        KEY_BACKSPACE_COMMAND,
        (event) => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
          const node = $getAdjacentNode(selection.focus, true);
          if (!$isSkillChipNode(node)) return false;
          event?.preventDefault();
          focusChipInput(node.getKey(), false);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      // §2: Delete (forward) left of a chip enters the arg input at start,
      // deletes nothing — the exact mirror of Backspace.
      editor.registerCommand(
        KEY_DELETE_COMMAND,
        (event) => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
          const node = $getAdjacentNode(selection.focus, false);
          if (!$isSkillChipNode(node)) return false;
          event?.preventDefault();
          focusChipInput(node.getKey(), true);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        (event) => {
          if (popoverStateRef.current) {
            event?.preventDefault();
            event?.stopImmediatePropagation();
            // §4: suppress THIS token until the caret leaves it or it's deleted.
            suppressedTokenRef.current = $findActiveSlashToken();
            closePopover();
            return true;
          }
          if (onEscapeRef.current) {
            event?.preventDefault();
            onEscapeRef.current();
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        (event) => {
          if (!popoverStateRef.current) return false;
          event?.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, Math.max(popoverItemsRef.current.length - 1, 0)));
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ARROW_UP_COMMAND,
        (event) => {
          if (!popoverStateRef.current) return false;
          event?.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      // §7: chips are not tab stops; while the popover is open, Tab
      // commits the active item (parity with the old composer's picker).
      editor.registerCommand(
        KEY_TAB_COMMAND,
        (event) => {
          if (!popoverStateRef.current) return false;
          event?.preventDefault();
          selectActivePopoverItem();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (popoverStateRef.current) {
            event?.preventDefault();
            selectActivePopoverItem();
            return true;
          }
          const isNewlineCombo = !!event && (event.shiftKey || event.altKey);
          if (isNewlineCombo) {
            event?.preventDefault();
            editor.dispatchCommand(INSERT_LINE_BREAK_COMMAND, false);
            return true;
          }
          event?.preventDefault();
          onSubmitRef.current();
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      // §6: copy/cut a range → text/plain is human-readable (`/name args`,
      // via SkillChipNode's own `getTextContent()` override); a private
      // MIME additionally carries the raw token fragment for in-app paste.
      editor.registerCommand(
        COPY_COMMAND,
        (event) => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || selection.isCollapsed()) return false;
          const clipboardEvent = event as ClipboardEvent;
          if (!clipboardEvent.clipboardData) return false;
          clipboardEvent.preventDefault();
          clipboardEvent.clipboardData.setData("text/plain", selection.getTextContent());
          clipboardEvent.clipboardData.setData(SKILL_CLIPBOARD_MIME, $serializeSelectionTokens(selection));
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        CUT_COMMAND,
        (event) => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || selection.isCollapsed()) return false;
          const clipboardEvent = event as ClipboardEvent;
          if (!clipboardEvent.clipboardData) return false;
          clipboardEvent.preventDefault();
          clipboardEvent.clipboardData.setData("text/plain", selection.getTextContent());
          clipboardEvent.clipboardData.setData(SKILL_CLIPBOARD_MIME, $serializeSelectionTokens(selection));
          selection.removeText();
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      // §4/§6: never auto-open the popover as a side effect of a paste.
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          pasteSuppressRef.current = true;
          const clipboardEvent = event as ClipboardEvent;
          const tokenData = clipboardEvent.clipboardData?.getData(SKILL_CLIPBOARD_MIME);
          if (!tokenData) return false; // let default plain-text paste happen — never auto-creates chips
          clipboardEvent.preventDefault();
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return true;
          selection.insertNodes(segmentsToNodes(parseSkillSegments(tokenData)));
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
    ];
    return () => unregisterFns.forEach((fn) => fn());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, inputRefs]);

  return null;
}

/**
 * Shared skill-invocation-aware message editor — replaces the plain
 * `<textarea>` at all three mount sites (Composer, QueuedTray's and
 * MessageList's `QueuedTurnEditor`). A contenteditable Lexical editor whose
 * document is (text | `SkillChipNode`)* — see the module doc on
 * `skillInvocation.ts` for the wire grammar this serializes to/from, and
 * `ux-chip-interaction-spec.md` for the full caret/selection contract this
 * implements.
 */
export const SkillEditor = forwardRef<SkillEditorHandle, SkillEditorProps>(function SkillEditor(
  {
    editorKey,
    initialText,
    commands,
    disabled,
    ariaLabel,
    placeholder,
    className,
    onChangeText,
    onSubmit,
    onEscape,
    onArgFocusChange,
  },
  ref,
) {
  const editorRef = useRef<LexicalEditor | null>(null);
  // A fresh map per `editorKey` (new Lexical editor instance) — the
  // dependency is intentional even though the initializer doesn't read it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const inputRefs = useMemo(() => new Map<NodeKey, HTMLInputElement>(), [editorKey]);
  const listboxId = useId();

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverQuery, setPopoverQuery] = useState("");
  const [activeIndex, setActiveIndexState] = useState(0);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // §4: the specific token Escape just closed, suppressed until the caret
  // leaves it or it's deleted — typing more must NOT reopen it.
  const suppressedTokenRef = useRef<{ nodeKey: NodeKey; start: number } | null>(null);
  // §4/§6: consumed once by the very next change-detection cycle after a
  // paste, so a pasted `/name` never auto-opens the popover.
  const pasteSuppressRef = useRef(false);

  const popoverOpenRef = useRef(popoverOpen);
  popoverOpenRef.current = popoverOpen;
  const popoverItems = commands ? filterCommands(commands, popoverQuery) : [];
  const popoverItemsRef = useRef(popoverItems);
  popoverItemsRef.current = popoverItems;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;

  const setActiveIndex = useCallback((updater: (i: number) => number) => {
    setActiveIndexState((i) => updater(i));
  }, []);

  const closePopover = useCallback(() => {
    setPopoverOpen(false);
    setPopoverQuery("");
    setActiveIndexState(0);
  }, []);

  const selectCommand = useCallback(
    (cmd: Command) => {
      const editor = editorRef.current;
      if (!editor) return;
      insertChipForActiveToken(editor, cmd.name, (nodeKey) => {
        const el = inputRefs.get(nodeKey);
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
      suppressedTokenRef.current = null;
      closePopover();
    },
    [closePopover, inputRefs],
  );

  const selectActivePopoverItem = useCallback(() => {
    const cmd = popoverItemsRef.current[activeIndexRef.current];
    if (cmd) selectCommand(cmd);
  }, [selectCommand]);

  // Pointerdown outside the popover closes it (parity with the old Composer).
  useEffect(() => {
    if (!popoverOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) closePopover();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [popoverOpen, closePopover]);

  useImperativeHandle(
    ref,
    () => ({
      getText: () => {
        const editor = editorRef.current;
        if (!editor) return "";
        return serializeEditor(editor).text;
      },
      clear: () => {
        const editor = editorRef.current;
        if (!editor) return;
        editor.update(() => {
          const root = $getRoot();
          root.clear();
          root.append($createParagraphNode());
        });
        suppressedTokenRef.current = null;
        closePopover();
        editor.focus();
      },
      focus: () => editorRef.current?.focus(),
    }),
    [closePopover],
  );

  const chipContextValue = useMemo(
    () => ({
      commands: commands ?? [],
      inputRefs,
      onCtrlEnter: onSubmit,
    }),
    [commands, inputRefs, onSubmit],
  );

  const initialConfig = useMemo(
    () => ({
      namespace: `skill-editor-${editorKey}`,
      nodes: EDITOR_NODES,
      onError: onLexicalError,
      editable: !disabled,
      editorState: seedEditorState(initialText),
    }),
    // Intentionally read once per `editorKey` — mirrors the old
    // `useState(() => ...)` lazy-init-once mount contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editorKey],
  );

  return (
    <SkillChipContext.Provider value={chipContextValue}>
      <LexicalComposer initialConfig={initialConfig}>
        <EditorRefCapture editorRef={editorRef} />
        {/* Shell: `position: relative` with NO overflow, so the absolutely
         *  positioned popover anchors here and is never clipped. The scroll
         *  box below owns `overflow-y: auto` for autosize — rendering the
         *  popover INSIDE that box clipped it to the editor's own height
         *  (~1 line), so it was in the DOM, sized, and simply not painted. */}
        <div
          className="chat-skill-editor-shell"
          style={{ position: "relative" }}
          onFocusCapture={(e) => {
            if (e.target instanceof HTMLInputElement && e.target.closest(".chat-skill-chip")) {
              onArgFocusChange?.(true);
            }
          }}
          onBlurCapture={(e) => {
            if (e.target instanceof HTMLInputElement && e.target.closest(".chat-skill-chip")) {
              onArgFocusChange?.(false);
            }
          }}
        >
          {popoverOpen && commands && popoverItems.length > 0 ? (
            <SkillPopover
              items={popoverItems}
              activeIndex={activeIndex}
              onHover={(i) => setActiveIndexState(i)}
              onSelect={selectCommand}
              listboxId={listboxId}
              popoverRef={popoverRef}
            />
          ) : null}
          <div
            className={`${className} chat-skill-editor`}
            style={{
              maxHeight: `calc(${COMPOSER_MAX_GROW_LINES} * var(--line-height-normal, 1.4) * 1em)`,
              overflowY: "auto",
            }}
          >
            <PlainTextPlugin
              contentEditable={
                <ContentEditable
                  aria-label={ariaLabel}
                  role={popoverOpen ? "combobox" : undefined}
                  aria-expanded={popoverOpen}
                  aria-controls={popoverOpen ? listboxId : undefined}
                  aria-activedescendant={popoverOpen ? `${listboxId}-${activeIndex}` : undefined}
                  className="chat-skill-editor__content"
                />
              }
              placeholder={
                placeholder ? (
                  <div className="chat-skill-editor__placeholder" aria-hidden>
                    {placeholder}
                  </div>
                ) : null
              }
              ErrorBoundary={LexicalErrorBoundary}
            />
            <HistoryPlugin />
            <OnChangePlugin
              // Deliberately NOT `ignoreSelectionChange`: the popover must
              // react to pure caret movement too — arrowing (or clicking) out
              // of a `/token` closes it, and arrowing back into a boundary
              // `/` reopens it (spec §4's "caret leaving the token" close
              // trigger has no text-change component).
              onChange={(_state, editor) => {
                // `hasContent` (7B.9) is "any chip node OR non-empty prose" —
                // read off the node tree during serialization, never by
                // un-tokenizing the escaped wire string afterwards.
                const { text, hasChip, hasText } = serializeEditor(editor);
                onChangeText(text, hasChip || hasText);

                editor.getEditorState().read(() => {
                  if (pasteSuppressRef.current) {
                    pasteSuppressRef.current = false;
                    suppressedTokenRef.current = null;
                    closePopover();
                    return;
                  }
                  const found = $findActiveSlashToken();
                  if (!found || commands === undefined) {
                    suppressedTokenRef.current = null;
                    closePopover();
                    return;
                  }
                  const suppressed = suppressedTokenRef.current;
                  if (suppressed && suppressed.nodeKey === found.nodeKey && suppressed.start === found.start) {
                    // Still the same token Escape closed — stay closed (§4).
                    return;
                  }
                  suppressedTokenRef.current = null;
                  const items = filterCommands(commands, found.query);
                  if (items.length === 0) {
                    closePopover();
                    return;
                  }
                  setPopoverQuery(found.query);
                  setPopoverOpen(true);
                  setActiveIndexState(0);
                });
              }}
            />
            <SkillEditorPlugin
              inputRefs={inputRefs}
              onSubmit={onSubmit}
              onEscape={onEscape}
              popoverStateRef={popoverOpenRef}
              selectActivePopoverItem={selectActivePopoverItem}
              closePopover={closePopover}
              setActiveIndex={setActiveIndex}
              popoverItemsRef={popoverItemsRef}
              suppressedTokenRef={suppressedTokenRef}
              pasteSuppressRef={pasteSuppressRef}
            />
          </div>
        </div>
      </LexicalComposer>
    </SkillChipContext.Provider>
  );
});

/** Stashes the `LexicalEditor` instance from context into a plain ref so
 *  imperative callers (`getText`/`clear`/`focus`) and the OnChange handler
 *  above can reach it outside React's render cycle. */
function EditorRefCapture({ editorRef }: { editorRef: React.MutableRefObject<LexicalEditor | null> }) {
  const [editor] = useLexicalComposerContext();
  editorRef.current = editor;
  return null;
}
