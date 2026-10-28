import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ApiInstance } from "@/api";
import { ReviewApiError } from "@/api/errors";
import type { ArtifactScopeKind, CommentDiffScope, CommentPathKind, CommentSurface, ReviewComment } from "@/api/types";
import type { MentionEditorConfig } from "@/components/mentions/types";
import { isHtmlPath } from "@/components/preview/htmlDocument";
import { usePortalRoot } from "@/context/DemoEnv";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { useServerStore } from "@/hooks/useServerStore";
import { copyText } from "@/lib/copyText";
import { sessionLabel } from "@/lib/sessionLabel";
import { randomId } from "@/lib/uuid";
import {
  describeCodeRow,
  describeDiffRow,
  describeSelection,
  anchorLabel,
  type DescribeContext,
  type SelectionResult,
} from "./anchorGeometry";
import { CommentBox, LIMIT_REACHED_TEXT, type RemovedNotice } from "./CommentBox";
import { anchorHash, clearDraft, draftKey, editDraftKey, listPathDrafts } from "./commentDrafts";
import { buildSurfaceComments, quoteStillAt } from "./rowIndex";
import { pinAriaLabel } from "./CommentPins";
import { isInsideCommentLayer, useOutsideTap } from "./useOutsideTap";
import { registerEscapeLayer } from "@/lib/escapeLayers";
import { DRAFT_ID, draftFromAnchor, requestFromComment } from "./draftComment";
import { PinMeasurer } from "./pinMeasurer";
import { EditCommentBox, NewCommentBox } from "./CommentRows";
import {
  CommentSurfaceContext,
  type DiffCorpus,
  type OpenBox,
  type OpenOpts,
  type CommentSurfaceValue,
} from "./CommentSurfaceContext";
import { useCommentScope, usePathComments } from "./commentSelectors";
import { SelectionPopover } from "./SelectionPopover";
import type { CommentAnchor } from "./types";
import { useApiOnline } from "./useApiOnline";
import { fetchCommentScope, useCommentScopeLoad } from "./useCommentsSync";
import { cssEscape } from "./commentJump";
import { useCommentShortcut } from "./useCommentShortcut";
import { useCommentStore } from "./useCommentStore";
import { useGutterRoving } from "./useGutterRoving";
import { MAX_COMMENTS } from "./reviewLimits";

interface Props {
  api: ApiInstance;
  scopeKind: ArtifactScopeKind;
  scopeId: string | null;
  /** Repo-relative path, or the absolute path of an artifact. */
  path: string | null;
  pathKind: CommentPathKind;
  /** The `[data-comment-surface]` element (`.preview-body`). */
  rootEl: HTMLElement | null;
  /** Why commenting is unavailable for what is on screen (commit scope, image, binary). */
  disabledReason: string | null;
  diffScope: "local" | "branch" | "none" | "commit";
  baseSha?: string;
  /** Current text of the file (code surface and the diff's new side). */
  fileText: string | null;
  children: ReactNode;
}

/** A restore hit a comment that is held by a queued send (409 `id_taken`): it comes back if that send is cancelled. */
const ID_TAKEN_TEXT = "This comment is in a queued send. Cancel the send to get it back.";

function errorText(e: unknown): string {
  if (e instanceof ReviewApiError) {
    if (e.code === "cap_reached") return LIMIT_REACHED_TEXT;
    if (e.code === "text_too_long") return "This comment is too long (8 KB max).";
    if (e.code === "quote_too_long") return "The quoted text is too long.";
    if (e.code === "invalid_anchor") return "Couldn’t anchor this comment.";
    if (e.code === "id_taken") return ID_TAKEN_TEXT;
  }
  return e instanceof Error ? e.message : "Couldn’t save the comment.";
}

const commentScope = (s: Props["diffScope"]): CommentDiffScope | undefined => (s === "local" || s === "branch" ? s : undefined);

/**
 * Owns everything a file preview needs to take comments (Decision 18): the open box, save / delete / restore
 * against the daemon, the selection mapping and the shortcuts. Wraps the pane so `DiffView`, `CodeView` and
 * `MarkdownView` find it through context; outside it (chat bubbles, tool cards) they stay inert.
 */
export function CommentSurfaceProvider({
  api,
  scopeKind,
  scopeId,
  path,
  pathKind,
  rootEl,
  disabledReason,
  diffScope,
  baseSha,
  fileText,
  children,
}: Props) {
  const enabled = !!scopeId && scopeId !== "__none__" && !!path && !disabledReason;
  useCommentScopeLoad(api, scopeKind, enabled ? scopeId : null);
  const scope = useCommentScope(scopeId);
  const all = usePathComments(scopeId, path);
  const online = useApiOnline(api);
  const sessions = useServerStore((s) => s.sessions);
  const worktrees = useServerStore((s) => s.worktrees);
  const store = useCommentStore;

  const [open, setOpen] = useState<OpenBox | null>(null);
  const [viewing, setViewing] = useState<{ ids: string[]; anchorEl: HTMLElement | null } | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const pinMeasurer = useMemo(() => new PinMeasurer(), []);
  useEffect(() => {
    pinMeasurer.attach(rootEl);
    return () => pinMeasurer.detach();
  }, [pinMeasurer, rootEl]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const portalRoot = usePortalRoot();
  const diffCorpus = useRef<DiffCorpus | null>(null);
  const setDiffCorpus = useCallback((c: DiffCorpus | null) => {
    diffCorpus.current = c;
  }, []);

  const fileLines = useMemo(() => (fileText == null ? null : fileText.split("\n")), [fileText]);
  const dScope = commentScope(diffScope);
  const codeSurface: CommentSurface = path && isHtmlPath(path) ? "html-source" : "file";
  const scopeKey = `${scopeKind}:${scopeId ?? ""}`;
  const total = scope?.comments.length ?? 0;
  const ordered = scope?.comments;

  const views = useMemo(
    () => ({
      diff: buildSurfaceComments(all, "diff", dScope),
      file: buildSurfaceComments(all, "file"),
      "html-source": buildSurfaceComments(all, "html-source"),
      markdown: buildSurfaceComments(all, "markdown"),
    }),
    [all, dScope],
  );

  const mentions = useMemo<MentionEditorConfig>(() => {
    const wt = scopeKind === "worktree" ? worktrees.find((w) => w.id === scopeId) : undefined;
    return {
      api,
      projectId: scopeKind === "project" ? scopeId : (wt?.projectId ?? null),
      worktreeId: scopeKind === "worktree" ? scopeId : null,
      selfSessionId: null,
      kinds: ["file"],
    };
  }, [api, scopeKind, scopeId, worktrees]);

  const describeContext = useCallback(
    (surface: CommentSurface): DescribeContext | null => {
      if (!rootEl) return null;
      return {
        root: rootEl,
        surface,
        diffScope: dScope,
        baseSha,
        fileLines: fileLines ?? undefined,
        newRows: diffCorpus.current?.newRows,
        oldRows: diffCorpus.current?.oldRows,
      };
    },
    [rootEl, dScope, baseSha, fileLines],
  );

  const surfaceAt = useCallback(
    (node: Node): CommentSurface | null => {
      const el = node instanceof Element ? node : node.parentElement;
      if (!el) return null;
      if (el.closest(".diff-line")) return "diff";
      if (el.closest(".workspace-markdown-preview")) return "markdown";
      if (el.closest(".workspace-code-line, .workspace-code-viewer")) return codeSurface;
      return null;
    },
    [codeSurface],
  );

  const describe = useCallback(
    (range: Range): SelectionResult => {
      const surface = surfaceAt(range.startContainer);
      if (!surface) return { ok: false, reason: "outside" };
      if (surface === "diff" && !dScope) return { ok: false, reason: "unsupported" };
      const ctx = describeContext(surface);
      return ctx ? describeSelection(range, ctx) : { ok: false, reason: "outside" };
    },
    [surfaceAt, describeContext, dScope],
  );

  const describeRowEl = useCallback(
    (row: HTMLElement): CommentAnchor | null => {
      if (row.classList.contains("diff-line")) {
        const ctx = dScope ? describeContext("diff") : null;
        return ctx ? describeDiffRow(row, ctx) : null;
      }
      const n = Number(row.getAttribute("data-line"));
      const ctx = describeContext(codeSurface);
      return ctx && Number.isFinite(n) ? describeCodeRow(n, ctx) : null;
    },
    [describeContext, dScope, codeSurface],
  );

  const focusBack = useCallback(
    (el: HTMLElement | null) => {
      requestAnimationFrame(() => {
        // A connected but disabled/hidden element cannot take focus; fall back to the surface root so the next
        // Esc still reaches the tools root.
        for (const c of [el, rootEl]) {
          if (!c?.isConnected) continue;
          c.focus?.({ preventScroll: true });
          if (document.activeElement === c) return;
        }
      });
    },
    [rootEl],
  );

  const boxDirty = useRef(false);
  const setBoxDirty = useCallback((d: boolean) => {
    boxDirty.current = d;
  }, []);

  const closeBox = useCallback(
    (restoreFocus: boolean) => {
      const prev = open;
      if (prev?.kind === "new") clearDraft(draftKey(scopeKey, path ?? "", prev.hash));
      if (prev?.kind === "edit") clearDraft(editDraftKey(scopeKey, prev.id));
      boxDirty.current = false;
      setOpen(null);
      setSaveError(null);
      if (restoreFocus) focusBack(prev?.returnFocus ?? null);
    },
    [open, scopeKey, path, focusBack],
  );
  const close = useCallback(() => closeBox(true), [closeBox]);
  const dismiss = useCallback(() => closeBox(false), [closeBox]);

  const openNew = useCallback(
    (anchor: CommentAnchor, opts?: OpenOpts) => {
      const active = document.activeElement;
      boxDirty.current = false;
      setSaveError(null);
      setViewing(null);
      setOpen({
        kind: "new",
        anchor,
        hash: anchorHash(anchor),
        newId: randomId(),
        returnFocus: opts?.returnFocus ?? (active instanceof HTMLElement && active !== document.body ? active : null),
        anchorEl: opts?.anchorEl ?? null,
      });
    },
    [],
  );

  const openEdit = useCallback(
    (id: string, opts?: OpenOpts) => {
      const c = scope?.comments.find((x) => x.id === id) ?? (open?.kind === "edit" && open.id === id ? open.snapshot : null);
      if (!c) return;
      boxDirty.current = false;
      setSaveError(null);
      setViewing(null);
      setOpen({ kind: "edit", id, snapshot: c, returnFocus: opts?.returnFocus ?? null, anchorEl: opts?.anchorEl ?? null });
    },
    [scope, open],
  );

  const removedNotice: RemovedNotice | undefined = useMemo(() => {
    if (open?.kind !== "edit") return undefined;
    const r = scope?.removed[open.id];
    return r ? { reason: r.reason } : undefined;
  }, [open, scope]);

  // An edit box whose comment vanished without a notice (our own delete) closes.
  useEffect(() => {
    if (open?.kind === "edit" && scope?.status === "ready" && !removedNotice && !scope.comments.some((c) => c.id === open.id)) {
      setOpen(null);
    }
  }, [open, scope, removedNotice]);

  const toRequest = (anchor: CommentAnchor, id: string, text: string) =>
    requestFromComment({ ...anchor, id, path: path!, pathKind }, text);

  const save = useCallback(
    (text: string) => {
      if (!open || !scopeId || !online || saving) return;
      setSaving(true);
      setSaveError(null);
      const done = (c: ReviewComment) => {
        store.getState().upsertLocal(c);
        close();
      };
      const p =
        open.kind === "new"
          ? api.createComment(scopeId, scopeKind, toRequest(open.anchor, open.newId, text))
          : api.patchComment(open.id, { text, version: open.snapshot.version });
      p.then(done, (e: unknown) => setSaveError(errorText(e))).finally(() => setSaving(false));
    },
    [open, scopeId, scopeKind, online, saving, api, close, path, pathKind],
  );

  const remove = useCallback(
    (id: string) => {
      if (!scopeId) return;
      store.getState().removeLocal(scopeId, [id]);
      clearDraft(editDraftKey(scopeKey, id));
      api.deleteComment(id).catch((e: unknown) => {
        // The comment still exists on the server (and "Attach all" could send it): bring it back and say so.
        void fetchCommentScope(api, scopeKind, scopeId);
        setDeleteError(`Couldn’t delete the comment: ${e instanceof Error ? e.message : "request failed"}`);
      });
    },
    [api, scopeId, scopeKind, scopeKey, store],
  );

  const restoreRemoved = useCallback(
    (text: string) => {
      if (open?.kind !== "edit" || !scopeId) return;
      const c = open.snapshot;
      const id = c.id;
      setSaving(true);
      api
        .createComment(scopeId, scopeKind, requestFromComment(c, text, c.pin))
        .then((created) => {
          store.getState().clearRemoved(scopeId, id);
          store.getState().upsertLocal(created);
          close();
        })
        .catch((e: unknown) => {
          if (e instanceof ReviewApiError && e.code === "id_taken") {
            // Held by a queued send: nothing to restore now. Drop the stale notice (the box closes, as on Discard)
            // and say why on the surface-level banner, which outlives the box.
            store.getState().clearRemoved(scopeId, id);
            setDeleteError(ID_TAKEN_TEXT);
            return;
          }
          setSaveError(errorText(e));
        })
        .finally(() => setSaving(false));
    },
    [open, scopeId, scopeKind, api, close, store],
  );

  const discardRemoved = useCallback(() => {
    if (open?.kind === "edit" && scopeId) store.getState().clearRemoved(scopeId, open.id);
    close();
  }, [open, scopeId, close, store]);

  const pinLabel = useCallback(
    (c: ReviewComment) => pinAriaLabel(c, (ordered?.findIndex((x) => x.id === c.id) ?? 0) + 1, total),
    [ordered, total],
  );
  const attachedLabel = useCallback(
    (c: ReviewComment) => {
      const id = c.attachedTo?.startsWith("session:") ? c.attachedTo.slice("session:".length) : null;
      const s = id ? sessions.find((x) => x.id === id) : undefined;
      return s ? sessionLabel(s) : undefined;
    },
    [sessions],
  );

  const stale = open?.kind === "new" && !quoteStillAt(open.anchor, fileLines);
  const draft = useMemo(
    () => (open?.kind === "new" && scopeId && path ? draftFromAnchor(open.anchor, { scopeKind, scopeId, path, pathKind }) : null),
    [open, scopeId, scopeKind, path, pathKind],
  );
  const activeId = open?.kind === "edit" ? open.id : null;

  const value = useMemo<CommentSurfaceValue | null>(() => {
    if (!enabled || !scopeId || !path) return null;
    return {
      enabled: true,
      disabledReason: null,
      scopeKind,
      scopeId,
      path,
      pathKind,
      diffScope: dScope,
      offline: !online,
      capReached: total >= MAX_COMMENTS,
      fileLines,
      rootEl,
      all,
      total,
      open,
      stale,
      removed: removedNotice,
      saveError,
      saving,
      mentions,
      forSurface: (s) => views[s],
      openNew,
      openEdit,
      close,
      dismiss,
      setBoxDirty,
      save,
      remove,
      restoreRemoved,
      discardRemoved,
      copyText: (t) => void copyText(t),
      describe,
      describeRowEl,
      describeContext,
      setDiffCorpus,
      pinLabel,
      pinMeasurer,
      draft,
      activeId,
      attachedLabel,
    };
  }, [enabled, scopeId, path, scopeKind, pathKind, dScope, online, total, fileLines, rootEl, all, open, stale, removedNotice, saveError, saving, mentions, views, openNew, openEdit, close, dismiss, setBoxDirty, save, remove, restoreRemoved, discardRemoved, describe, describeRowEl, describeContext, setDiffCorpus, pinLabel, pinMeasurer, draft, activeId, attachedLabel]);

  const valueRef = useRef(value);
  valueRef.current = value;

  // Reopen a stored draft for this file (survives a tab / rail / worktree switch and a reload).
  useEffect(() => {
    if (!enabled || !path || !scopeId) return;
    setOpen((cur) => {
      if (cur) return cur;
      const d = listPathDrafts(scopeKey, path)[0];
      return d ? { kind: "new", anchor: d.anchor, hash: anchorHash(d.anchor), newId: randomId(), returnFocus: null, anchorEl: null } : cur;
    });
    // Only when the file changes.
  }, [enabled, path, scopeId, scopeKey]);

  // A box belongs to one file: leaving it hides (its draft stays stored).
  const openPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (open && openPathRef.current && openPathRef.current !== path) setOpen(null);
    openPathRef.current = open ? path : null;
  }, [open, path]);

  useGutterRoving(rootEl, enabled);

  useCommentShortcut(enabled, {
    onSelection: () => {
      const v = valueRef.current;
      const sel = document.getSelection();
      if (!v || !sel || sel.rangeCount === 0) return false;
      if (rootEl && !rootEl.contains(sel.anchorNode)) return false;
      const res = v.describe(sel.getRangeAt(0));
      if (!res.ok) return false;
      v.openNew(res.anchor, { anchorEl: res.endEl });
      sel.removeAllRanges();
      return true;
    },
    onPlus: (plus) => {
      const v = valueRef.current;
      // Several surfaces can be mounted (one per tools tile), all listening on `document`: only the owner of this `+`.
      if (rootEl && !rootEl.contains(plus)) return false;
      const row = plus.closest<HTMLElement>(".diff-line, .workspace-code-line");
      const anchor = v && row ? v.describeRowEl(row) : null;
      if (!v || !anchor) return false;
      v.openNew(anchor, { returnFocus: plus });
      return true;
    },
  });

  // Rendered-markdown pins: delegated click toggles the view card(s) of the pin (a merged stack opens all); an
  // outside tap, Esc (escape layer) or a second tap closes them. Opening another pin replaces the card.
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;
  useEffect(() => {
    if (!rootEl || !enabled) return;
    const onClick = (e: MouseEvent) => {
      const pin = e.target instanceof Element ? e.target.closest<HTMLElement>(".workspace-markdown-preview [data-comment-pin]") : null;
      if (!pin) return;
      e.preventDefault();
      const group = pin.closest<HTMLElement>("[data-comment-ids]")?.getAttribute("data-comment-ids")?.split(" ").filter(Boolean);
      const ids = group?.length ? group : [pin.getAttribute("data-comment-pin")!];
      const v = valueRef.current;
      if (v?.open) {
        // A box is open in the float: a box holding text already asked to discard (its own outside-tap rule).
        if (boxDirty.current) return;
        v.dismiss();
      }
      const cur = viewingRef.current;
      const toggling = !!cur && sameIds(cur.ids, ids);
      setViewing(toggling ? null : { ids, anchorEl: pin });
      if (toggling) focusBack(pin);
    };
    rootEl.addEventListener("click", onClick);
    return () => rootEl.removeEventListener("click", onClick);
  }, [rootEl, enabled, focusBack]);

  // The view card's Esc goes through the escape-layer stack (a box registers its own `comment-box` layer, and the
  // card is never shown with a box).
  useEffect(() => {
    if (!viewing || open) return undefined;
    return registerEscapeLayer("comment-box", () => {
      setViewing(null);
      focusBack(viewing.anchorEl);
      return true;
    }, () => rootEl?.closest(".tool-panel") ?? null);
  }, [viewing, open, focusBack, rootEl]);

  useOutsideTap(!!viewing && !open, {
    inside: (t) => isInsideCommentLayer(t, { pins: true }),
    onTap: () => setViewing(null),
  });

  // Pin <-> span link: hovering or focusing a pin (or a highlighted span) lights up both (a rule, not DOM edits).
  useEffect(() => {
    if (!rootEl || !enabled) return;
    const idAt = (t: EventTarget | null): string | null => {
      const el = t instanceof Element ? t.closest<HTMLElement>("[data-comment-pin], mark[data-comment-id]") : null;
      const id = el?.getAttribute("data-comment-pin") ?? el?.getAttribute("data-comment-id") ?? null;
      return id && id !== DRAFT_ID ? id : null;
    };
    const over = (e: Event) => setHoverId(idAt(e.target));
    const out = () => setHoverId(null);
    rootEl.addEventListener("mouseover", over);
    rootEl.addEventListener("focusin", over);
    rootEl.addEventListener("mouseleave", out);
    rootEl.addEventListener("focusout", out);
    return () => {
      rootEl.removeEventListener("mouseover", over);
      rootEl.removeEventListener("focusin", over);
      rootEl.removeEventListener("mouseleave", out);
      rootEl.removeEventListener("focusout", out);
    };
  }, [rootEl, enabled]);

  if (!value) {
    return <CommentSurfaceContext.Provider value={null}>{children}</CommentSurfaceContext.Provider>;
  }

  const mdOpen = open && (open.kind === "new" ? open.anchor.surface === "markdown" : open.snapshot.surface === "markdown");
  const viewedList = viewing ? viewing.ids.map((id) => all.find((c) => c.id === id)).filter((c): c is ReviewComment => !!c) : [];
  const viewed = viewedList[0];

  return (
    <CommentSurfaceContext.Provider value={value}>
      {children}
      {hoverId ? <style>{hoverRule(hoverId)}</style> : null}
      <SelectionPopover surface={value} rootEl={rootEl} />
      {deleteError
        ? createPortal(
            <div className="comment-delete-error">
              <Banner
                tone="error"
                actions={
                  <Button size="sm" onClick={() => setDeleteError(null)}>
                    Dismiss
                  </Button>
                }
              >
                {deleteError}
              </Banner>
            </div>,
            portalRoot,
          )
        : null}
      {rootEl && (mdOpen || viewed) && !(open && !mdOpen)
        ? createPortal(
            <MarkdownFloat
              rootEl={rootEl}
              anchorEl={open?.anchorEl ?? viewing?.anchorEl ?? null}
              focusKey={!open && viewing ? viewing.ids.join(" ") : null}
            >
              {open?.kind === "new" ? (
                <NewCommentBox surface={value} open={open} floating />
              ) : open?.kind === "edit" ? (
                <EditCommentBox surface={value} comment={scope?.comments.find((c) => c.id === open.id) ?? open.snapshot} floating />
              ) : viewedList.length ? (
                viewedList.map((v) => (
                  <CommentBox
                    key={v.id}
                    mode="view"
                    label={anchorLabel(v)}
                    quote={v.quote}
                    comment={v}
                    offline={value.offline}
                    attachedLabel={value.attachedLabel(v)}
                    onEdit={() => value.openEdit(v.id, { anchorEl: viewing?.anchorEl ?? null, returnFocus: viewing?.anchorEl ?? null })}
                    onDelete={() => {
                      value.remove(v.id);
                      setViewing(null);
                    }}
                  />
                ))
              ) : null}
            </MarkdownFloat>,
            rootEl,
          )
        : null}
    </CommentSurfaceContext.Provider>
  );
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/** Rule lighting up a comment's span marks and its pin together (`--comment-hl-active`, tokens.css). */
function hoverRule(id: string): string {
  const e = cssEscape(id);
  return (
    `[data-comment-surface] mark.comment-hl[data-comment-id="${e}"]{background:var(--comment-hl-active)}` +
    `[data-comment-surface] .comment-pin[data-comment-pin="${e}"]{box-shadow:0 0 0 2px var(--comment)}`
  );
}

/** Box for a surface without rows: absolutely placed under the anchor element inside the scroll container. */
function MarkdownFloat({
  rootEl,
  anchorEl,
  focusKey,
  children,
}: {
  rootEl: HTMLElement;
  anchorEl: HTMLElement | null;
  /** Set while a view card is shown: focus moves to its first action when the key changes. */
  focusKey: string | null;
  children: ReactNode;
}) {
  const [top, setTop] = useState(16);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const place = () => {
      if (!anchorEl?.isConnected) return setTop(rootEl.scrollTop + 16);
      setTop(anchorEl.getBoundingClientRect().bottom - rootEl.getBoundingClientRect().top + rootEl.scrollTop + 6);
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [rootEl, anchorEl]);
  useLayoutEffect(() => {
    if (focusKey == null) return;
    ref.current?.querySelector<HTMLElement>("[data-comment-card] button")?.focus({ preventScroll: true });
    ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [focusKey]);
  return (
    <div ref={ref} className="comment-float" style={{ top }} data-comment-float>
      {children}
    </div>
  );
}
