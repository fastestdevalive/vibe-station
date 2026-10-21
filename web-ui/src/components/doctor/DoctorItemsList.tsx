import { useState } from "react";
import type { ApiInstance } from "@/api";
import { ApiError } from "@/api/errors";
import type { DoctorItemDto } from "@/api/types";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { CommandBlock } from "./CommandBlock";
import "./doctor.css";

interface DoctorItemsListProps {
  api: ApiInstance;
  items: DoctorItemDto[];
  /** Show only this many rows until "Show N more" is clicked. */
  collapsedCount?: number;
  /** Called after any action finished, so the caller can re-run the doctor. */
  onChanged: () => void;
}

const ACTION_LABEL = { forget: "Forget", kill: "Kill", retry: "Retry" } as const;

/**
 * Orphan worktrees (Forget) / tmux sessions (Kill): one row per item with an
 * in-app action, plus the copyable CLI equivalent. Forget is the plain
 * `DELETE /worktrees/:id` (no done-check); Kill hits the validated doctor route.
 */
export function DoctorItemsList({ api, items, collapsedCount, onChanged }: DoctorItemsListProps) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ kind: "one"; item: DoctorItemDto } | { kind: "all" } | null>(null);
  const [notes, setNotes] = useState<Record<string, { text: string; error: boolean }>>({});

  const visible =
    collapsedCount != null && !expanded && items.length > collapsedCount
      ? items.slice(0, collapsedCount)
      : items;
  const hidden = items.length - visible.length;
  const action = items[0]?.action;

  /** Run one item's action. Resolves to a note to show on the row, or null on success. */
  async function run(item: DoctorItemDto): Promise<{ text: string; error: boolean } | null> {
    try {
      if (item.action === "forget") await api.deleteWorktree(item.id);
      else if (item.action === "kill") await api.killOrphanSession(item.id);
      return null;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        // Already gone: forgetting is idempotent; a kill target that is no
        // longer orphaned is worth saying so.
        return item.action === "kill" ? { text: "No longer orphaned", error: false } : null;
      }
      return { text: e instanceof Error ? e.message : String(e), error: true };
    }
  }

  async function runOne(item: DoctorItemDto) {
    setBusy(true);
    const note = await run(item);
    setNotes((n) => ({ ...n, [item.id]: note ?? { text: "Done", error: false } }));
    setBusy(false);
    onChanged();
  }

  function requestOne(item: DoctorItemDto) {
    if (item.action === "retry") void runOne(item);
    else setPending({ kind: "one", item });
  }

  async function runAll() {
    setBusy(true);
    const next: Record<string, { text: string; error: boolean }> = {};
    for (const item of items) {
      const note = await run(item);
      if (note) next[item.id] = note;
    }
    setNotes((n) => ({ ...n, ...next }));
    setBusy(false);
    onChanged();
  }

  const confirmAction = pending ? (pending.kind === "one" ? pending.item.action : action) : undefined;
  const confirmCopy =
    confirmAction === "kill"
      ? "This terminates the live tmux session(s) immediately. They may belong to another vibe-station daemon running on this machine. This cannot be undone."
      : "This permanently deletes the worktree and session records from vibe-station. This cannot be undone.";
  const confirmTarget = pending ? (pending.kind === "one" ? pending.item.label : `all ${items.length} items`) : "";

  function onConfirm() {
    const p = pending;
    setPending(null);
    if (!p) return;
    if (p.kind === "one") void runOne(p.item);
    else void runAll();
  }

  return (
    <div className="doctor-items">
      <ConfirmDialog
        open={pending !== null && confirmAction != null && confirmAction !== "retry"}
        title={`${confirmAction ? ACTION_LABEL[confirmAction] : ""} ${confirmTarget}?`}
        message={confirmCopy}
        confirmLabel={confirmAction ? ACTION_LABEL[confirmAction] : "Confirm"}
        onConfirm={onConfirm}
        onCancel={() => setPending(null)}
      />
      {visible.map((item) => {
        const note = notes[item.id];
        return (
          <div className="doctor-items__row" key={item.id}>
            <div className="doctor-items__text">
              <div className="doctor-items__label selectable">{item.label}</div>
              {item.path ? <div className="doctor-items__path selectable">{item.path}</div> : null}
              {note ? (
                <div className={`doctor-items__note${note.error ? " doctor-items__note--error" : ""}`}>
                  {note.text}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => requestOne(item)}
              aria-label={`${ACTION_LABEL[item.action]} ${item.label}`}
            >
              {ACTION_LABEL[item.action]}
            </button>
          </div>
        );
      })}
      <div className="doctor-items__toolbar">
        {hidden > 0 ? (
          <button type="button" className="btn btn--ghost" onClick={() => setExpanded(true)}>
            Show {hidden} more
          </button>
        ) : null}
        {items.length > 1 && action ? (
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setPending({ kind: "all" })}>
            {ACTION_LABEL[action]} all {items.length}
          </button>
        ) : null}
      </div>
      {items[0] ? (
        <>
          <div className="doctor-items__terminal">Or from a terminal:</div>
          <CommandBlock command={items.map((i) => i.command).join("\n")} />
        </>
      ) : null}
    </div>
  );
}
