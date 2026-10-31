import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  COMMAND_PRIORITY_CRITICAL,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type NodeKey,
  mergeRegister,
} from "lexical";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useEventTargets } from "@/context/DemoEnv";
import { mentionKindDef } from "./kinds";
import {
  $findActiveAtToken,
  countMentions,
  insertMentionForActiveToken,
  rewriteActiveAtToken,
} from "./mentionOps";
import { type MentionProjectRef, parseMentionQuery } from "./mentionQuery";
import { buildMentionRows, type MentionRow, selectableRows } from "./mentionRows";
import { MentionPopover } from "./MentionPopover";
import type { MentionEditorConfig } from "./types";
import { useMentionSources } from "./useMentionSources";
import { useServerStore } from "@/hooks/useServerStore";
import { MAX_MENTIONS } from "@/lib/mentions";

export interface MentionPluginProps {
  config: MentionEditorConfig;
  mentionStateRef: React.MutableRefObject<{ open: boolean; hasSelectable: boolean }>;
  onOpenChange: (state: { listboxId: string; activeOrdinal: number } | null) => void;
}

export function MentionPlugin({
  config,
  mentionStateRef,
  onOpenChange,
}: MentionPluginProps) {
  const [editor] = useLexicalComposerContext();
  const { doc } = useEventTargets();
  const listboxId = useId();

  const [uiState, setUiState] = useState<{
    open: boolean;
    raw: string;
    activeOrdinal: number;
  }>({
    open: false,
    raw: "",
    activeOrdinal: 0,
  });

  const uiStateRef = useRef(uiState);
  uiStateRef.current = uiState;

  const configRef = useRef(config);
  configRef.current = config;

  const fileScope = config.worktreeId ? "worktree" : "project";
  const fileScopeRef = useRef<"worktree" | "project">(fileScope);
  fileScopeRef.current = fileScope;

  const suppressedTokenRef = useRef<{ nodeKey: NodeKey; start: number } | null>(null);
  const pasteSuppressRef = useRef(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Visible projects, for the `@worktrees:<project>:<worktree>` grammar.
  const serverProjects = useServerStore((s) => s.projects);
  const projectRefs: MentionProjectRef[] = useMemo(
    () => serverProjects.filter((p) => !p.hidden).map((p) => ({ id: p.id, name: p.name })),
    [serverProjects],
  );
  const projectRefsRef = useRef(projectRefs);
  projectRefsRef.current = projectRefs;

  const parsed = useMemo(() => parseMentionQuery(uiState.raw, projectRefs), [uiState.raw, projectRefs]);
  const sources = useMentionSources(config, parsed, uiState.open);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  const [limitReached, setLimitReached] = useState(false);
  const limitReachedRef = useRef(limitReached);
  limitReachedRef.current = limitReached;

  const rows = useMemo(() => {
    if (!uiState.open) return [];
    return buildMentionRows(parsed, sources, { limitReached, fileScope, currentProjectId: config.projectId });
  }, [uiState.open, parsed, sources, limitReached, fileScope, config.projectId]);

  const rowsRef = useRef<MentionRow[]>(rows);
  rowsRef.current = rows;

  const syncState = useCallback(
    (next: { open: boolean; raw: string; activeOrdinal: number }) => {
      let isLimit = false;
      editor.getEditorState().read(() => {
        isLimit = countMentions() >= MAX_MENTIONS;
      });
      setLimitReached(isLimit);
      limitReachedRef.current = isLimit;

      const p = parseMentionQuery(next.raw, projectRefsRef.current);
      const nextRows = next.open
        ? buildMentionRows(p, sourcesRef.current, {
            limitReached: isLimit,
            fileScope: fileScopeRef.current,
            currentProjectId: configRef.current.projectId,
          })
        : [];
      const hasSelectable =
        next.open && nextRows.some((r) => r.type === "scope" || r.type === "item");

      uiStateRef.current = next;
      rowsRef.current = nextRows;
      mentionStateRef.current = { open: next.open, hasSelectable };
      setUiState(next);
    },
    [editor, mentionStateRef],
  );

  const close = useCallback(() => {
    syncState({ open: false, raw: "", activeOrdinal: 0 });
  }, [syncState]);

  // One rewrite path for every scope row (`@files:`, `@worktrees:<project>:` …)
  // so keyboard and mouse selection can't drift. `syncState.raw` must equal
  // the rewritten token minus `@`, or the active ordinal resets.
  const applyScopeRow = (row: Extract<MentionRow, { type: "scope" }>) => {
    const raw = row.insertRaw ?? `${mentionKindDef(row.kind).section}:`;
    rewriteActiveAtToken(editor, `@${raw}`);
    suppressedTokenRef.current = null;
    syncState({ open: true, raw, activeOrdinal: 0 });
  };
  const applyScopeRowRef = useRef(applyScopeRow);
  applyScopeRowRef.current = applyScopeRow;

  const selectActiveRef = useRef<() => void>(() => {});
  selectActiveRef.current = () => {
    const selectable = selectableRows(rowsRef.current);
    const active = selectable[uiStateRef.current.activeOrdinal];
    if (!active) return;

    if (active.type === "scope") {
      applyScopeRowRef.current(active);
      return;
    }

    if (active.type === "item") {
      insertMentionForActiveToken(editor, {
        kind: active.item.kind,
        id: active.item.id,
        label: active.item.label,
      });
      suppressedTokenRef.current = null;
      close();
    }
  };

  useEffect(() => {
    const isSelectable = (r: MentionRow): boolean => r.type === "scope" || r.type === "item";
    const handles = (): boolean => uiStateRef.current.open && rowsRef.current.some(isSelectable);

    const onPasteCapture = () => {
      pasteSuppressRef.current = true;
    };

    return mergeRegister(
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (e) => {
          if (e?.isComposing) {
            e?.preventDefault();
            return true;
          }
          if (!handles()) return false;
          e?.preventDefault();
          selectActiveRef.current();
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        KEY_TAB_COMMAND,
        (e) => {
          if (e?.isComposing || !handles()) return false;
          e?.preventDefault();
          selectActiveRef.current();
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        (e) => {
          if (e?.isComposing || !handles()) return false;
          e?.preventDefault();
          const selectable = selectableRows(rowsRef.current);
          if (selectable.length === 0) return true;
          const next = (uiStateRef.current.activeOrdinal + 1) % selectable.length;
          setUiState((s) => ({ ...s, activeOrdinal: next }));
          uiStateRef.current.activeOrdinal = next;
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        KEY_ARROW_UP_COMMAND,
        (e) => {
          if (e?.isComposing || !handles()) return false;
          e?.preventDefault();
          const selectable = selectableRows(rowsRef.current);
          if (selectable.length === 0) return true;
          const next = (uiStateRef.current.activeOrdinal - 1 + selectable.length) % selectable.length;
          setUiState((s) => ({ ...s, activeOrdinal: next }));
          uiStateRef.current.activeOrdinal = next;
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        (e) => {
          if (e?.isComposing) return false;
          if (!uiStateRef.current.open) return false;
          e?.preventDefault();
          e?.stopImmediatePropagation();
          editor.getEditorState().read(() => {
            const token = $findActiveAtToken();
            if (token) {
              suppressedTokenRef.current = { nodeKey: token.nodeKey, start: token.start };
            }
          });
          close();
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerRootListener((root, prev) => {
        prev?.removeEventListener("paste", onPasteCapture, true);
        root?.addEventListener("paste", onPasteCapture, true);
      }),
    );
  }, [editor, close]);

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        if (pasteSuppressRef.current) {
          pasteSuppressRef.current = false;
          suppressedTokenRef.current = null;
          close();
          return;
        }

        const found = $findActiveAtToken();
        if (!found) {
          suppressedTokenRef.current = null;
          close();
          return;
        }

        const suppressed = suppressedTokenRef.current;
        if (suppressed && suppressed.nodeKey === found.nodeKey && suppressed.start === found.start) {
          return;
        }
        suppressedTokenRef.current = null;

        const activeOrdinal =
          found.raw === uiStateRef.current.raw ? uiStateRef.current.activeOrdinal : 0;
        syncState({
          open: true,
          raw: found.raw,
          activeOrdinal,
        });
      });
    });
  }, [editor, close, syncState]);

  useEffect(() => {
    if (!uiState.open) return;
    function onPointerDown(e: PointerEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        close();
      }
    }
    doc.addEventListener("pointerdown", onPointerDown);
    return () => doc.removeEventListener("pointerdown", onPointerDown);
  }, [uiState.open, close, doc]);

  // A space-containing query with zero selectable rows (and nothing still
  // loading) is plain text: close so Enter behaves normally. Debounced so a
  // pending file search can land first.
  useEffect(() => {
    if (!uiState.open || !/\s/.test(uiState.raw)) return;
    const settled = !rows.some(
      (r) => r.type === "scope" || r.type === "item" || (r.type === "status" && r.text.startsWith("Searching")),
    );
    if (!settled) return;
    const t = setTimeout(() => close(), 250);
    return () => clearTimeout(t);
  }, [uiState.open, uiState.raw, rows, close]);

  useEffect(() => {
    if (uiState.open) {
      const hasSelectable = rows.some((r) => r.type === "scope" || r.type === "item");
      mentionStateRef.current = { open: true, hasSelectable };
    } else {
      mentionStateRef.current = { open: false, hasSelectable: false };
    }
  }, [uiState.open, rows, mentionStateRef]);

  useEffect(() => {
    if (uiState.open) {
      onOpenChange({ listboxId, activeOrdinal: uiState.activeOrdinal });
    } else {
      onOpenChange(null);
    }
  }, [uiState.open, listboxId, uiState.activeOrdinal, onOpenChange]);

  if (!uiState.open) {
    return null;
  }

  return (
    <MentionPopover
      rows={rows}
      activeOrdinal={uiState.activeOrdinal}
      parsed={parsed}
      onHover={(ordinal) => {
        setUiState((s) => ({ ...s, activeOrdinal: ordinal }));
        uiStateRef.current.activeOrdinal = ordinal;
      }}
      onSelect={(row) => {
        if (row.type === "scope") {
          applyScopeRow(row);
        } else if (row.type === "item") {
          insertMentionForActiveToken(editor, {
            kind: row.item.kind,
            id: row.item.id,
            label: row.item.label,
          });
          suppressedTokenRef.current = null;
          close();
        }
      }}
      listboxId={listboxId}
      popoverRef={popoverRef}
    />
  );
}
