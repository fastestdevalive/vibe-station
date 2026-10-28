import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ReviewComment } from "@/api/types";
import { Banner } from "@/components/ui/Banner";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { cantCheckCopy, commentLineLabel, sortForList } from "./commentSelectors";
import { showInvisibles } from "./visibleText";
import { MAX_COMMENTS } from "./reviewLimits";
import { LIMIT_REACHED_TEXT } from "./CommentBox";
import type { CommentsStatus } from "./useCommentStore";

/** Rows above which the list is virtualised (R58). */
export const VIRTUALISE_ABOVE = 60;
const ROW_ESTIMATE = 76;
const HEADER_ESTIMATE = 34;

type Entry =
  | { kind: "needs"; total: number; selected: number }
  | { kind: "attached"; total: number; where: string }
  | { kind: "row"; c: ReviewComment; section: "needs" | "attached" };

export interface CommentsListProps {
  comments: readonly ReviewComment[];
  status: CommentsStatus;
  /** Ids the user unticked in "Needs you" (everything else is ticked by default). */
  unchecked: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[], checked: boolean) => void;
  onOpen: (c: ReviewComment) => void;
  onDetach: (c: ReviewComment) => void;
  onRetryLoad: () => void;
  /** Agent name for a `session:<id>` composer key. */
  composerName: (key: string) => string;
}

/** `in the main chat box` / `in 2 chat boxes` for the "Attached" header. */
export function attachedWhere(keys: string[], name: (key: string) => string): string {
  const uniq = [...new Set(keys)];
  return uniq.length === 1 ? `in the ${name(uniq[0]!)} chat box` : `in ${uniq.length} chat boxes`;
}

function buildEntries(
  needs: ReviewComment[],
  attached: ReviewComment[],
  unchecked: ReadonlySet<string>,
  name: (key: string) => string,
): Entry[] {
  const out: Entry[] = [];
  if (needs.length > 0) {
    out.push({ kind: "needs", total: needs.length, selected: needs.filter((c) => !unchecked.has(c.id)).length });
    for (const c of needs) out.push({ kind: "row", c, section: "needs" });
  }
  if (attached.length > 0) {
    out.push({ kind: "attached", total: attached.length, where: attachedWhere(attached.map((c) => c.attachedTo!), name) });
    for (const c of attached) out.push({ kind: "row", c, section: "attached" });
  }
  return out;
}

/**
 * The expanded tray list (`CommentsList` board): "Needs you" (unsent, ticked by default, with select-all) and,
 * only when something is attached, "Attached". Sorted by file, no status filters and no Sent section (rows
 * leave on send, R58 / R67). Above 60 rows it is virtualised.
 */
export function CommentsList(props: CommentsListProps) {
  const { comments, status, unchecked, onToggle, onToggleAll, onOpen, onDetach, onRetryLoad, composerName } = props;
  const sorted = useMemo(() => sortForList(comments), [comments]);
  const needs = useMemo(() => sorted.filter((c) => !c.attachedTo), [sorted]);
  const attached = useMemo(() => sorted.filter((c) => !!c.attachedTo), [sorted]);
  const entries = useMemo(() => buildEntries(needs, attached, unchecked, composerName), [needs, attached, unchecked, composerName]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = comments.length > VIRTUALISE_ABOVE;

  const rowProps = { unchecked, onToggle, onOpen, onDetach, composerName };

  const virtualizer = useVirtualizer({
    count: virtual ? entries.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (entries[i]?.kind === "row" ? ROW_ESTIMATE : HEADER_ESTIMATE),
    overscan: 6,
    // Without layout (first paint, jsdom) the window still renders a screenful.
    initialRect: { width: 400, height: 380 },
  });

  let body;
  if (status === "error") {
    body = (
      <Banner tone="error" actions={<button type="button" className="comment-btn" onClick={onRetryLoad}>Retry</button>}>
        Couldn’t load comments.
      </Banner>
    );
  } else if (status !== "ready" && comments.length === 0) {
    body = (
      <div className="comment-list__skeleton" role="status" aria-busy="true">
        Loading comments…
      </div>
    );
  } else if (comments.length === 0) {
    body = (
      <EmptyState title="No comments yet." meta="Select text and press C, or click + in a gutter." />
    );
  } else if (virtual) {
    body = (
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((v) => {
          const e = entries[v.index];
          if (!e) return null;
          return (
            <div
              key={v.key}
              data-index={v.index}
              ref={virtualizer.measureElement}
              className="comment-list__virtual"
              style={{ transform: `translateY(${v.start}px)` }}
            >
              <EntryView e={e} needs={needs} onToggleAll={onToggleAll} {...rowProps} />
            </div>
          );
        })}
      </div>
    );
  } else {
    body = entries.map((e, i) => (
      <EntryView key={e.kind === "row" ? e.c.id : `${e.kind}-${i}`} e={e} needs={needs} onToggleAll={onToggleAll} {...rowProps} />
    ));
  }

  return (
    <div className="comment-list" ref={scrollRef} role="group" aria-label="Review comments">
      {body}
      {comments.length >= MAX_COMMENTS ? <div className="comment-list__cap">{LIMIT_REACHED_TEXT}</div> : null}
    </div>
  );
}

interface RowShared {
  unchecked: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onOpen: (c: ReviewComment) => void;
  onDetach: (c: ReviewComment) => void;
  composerName: (key: string) => string;
}

function EntryView({
  e,
  needs,
  onToggleAll,
  ...row
}: { e: Entry; needs: ReviewComment[]; onToggleAll: (ids: string[], checked: boolean) => void } & RowShared) {
  if (e.kind === "needs") {
    const all = e.selected === e.total;
    const none = e.selected === 0;
    return (
      <div className="comment-list__sec">
        <label className="comment-cb-hit">
        <input
          type="checkbox"
          className="comment-cb"
          aria-label="Select all"
          checked={all}
          ref={(el) => {
            if (el) el.indeterminate = !all && !none;
          }}
          onChange={() =>
            onToggleAll(
              needs.map((c) => c.id),
              !all,
            )
          }
        />
        </label>
        <span>Needs you</span>
        <span className="comment-list__sec-n">{`· ${e.total} · ${e.selected} selected`}</span>
      </div>
    );
  }
  if (e.kind === "attached") {
    return (
      <div className="comment-list__sec comment-list__sec--attached">
        <span>Attached</span>
        <span className="comment-list__sec-n">{`· ${e.total} · ${e.where}`}</span>
      </div>
    );
  }
  return <RowView c={e.c} section={e.section} {...row} />;
}

function RowView({ c, section, unchecked, onToggle, onOpen, onDetach, composerName }: { c: ReviewComment; section: "needs" | "attached" } & RowShared) {
  const line = commentLineLabel(c);
  const cant = cantCheckCopy(c);
  const outside = c.pathKind === "artifact" && c.path.startsWith("/");
  const missing = c.anchor === "file_missing";
  const quote = c.quote.split("\n", 1)[0] ?? "";
  return (
    <div
      className={`comment-list__item${c.anchor === "outdated" ? " comment-list__item--out" : ""}`}
      data-comment-row={c.id}
    >
      {section === "needs" ? (
        <label className="comment-cb-hit">
        <input
          type="checkbox"
          className="comment-cb"
          aria-label={`Select comment ${c.pin}`}
          checked={!unchecked.has(c.id)}
          onChange={() => onToggle(c.id)}
        />
        </label>
      ) : (
        <span className="comment-list__attached-ico" aria-hidden />
      )}
      <div className="comment-list__b">
        <div className="comment-list__f">
          <span className="comment-list__pin" data-pin={c.pin} aria-hidden>
            #{c.pin}
          </span>
          <button
            type="button"
            className="comment-list__link"
            title={c.path}
            aria-label={`Open ${c.path}${line ? ` at ${line}` : ""}`}
            onClick={() => onOpen(c)}
          >
            {missing ? <s>{c.path}</s> : c.path}
          </button>
          {line ? <span>{line}</span> : null}
          <span className="comment-list__sp" />
          {c.anchor === "outdated" ? (
            <Chip tone="warn" size="sm">
              outdated
            </Chip>
          ) : null}
          {outside ? (
            <Chip tone="warn" size="sm">
              outside repo
            </Chip>
          ) : null}
          {missing ? <span className="comment-list__muted">(sent with “file no longer exists”)</span> : null}
          {cant ? (
            <span className="comment-list__muted" title={cant.title}>
              {cant.text}
            </span>
          ) : null}
          {section === "attached" && c.attachedTo ? (
            <>
              <Chip tone="neutral" size="sm">{`attached · ${composerName(c.attachedTo)}`}</Chip>
              <button type="button" className="comment-btn comment-btn--ghost comment-list__detach" onClick={() => onDetach(c)}>
                Detach
              </button>
            </>
          ) : null}
        </div>
        {quote ? <div className="comment-list__q">{showInvisibles(quote)}</div> : null}
        <div className="comment-list__text">{showInvisibles(c.text)}</div>
      </div>
    </div>
  );
}
