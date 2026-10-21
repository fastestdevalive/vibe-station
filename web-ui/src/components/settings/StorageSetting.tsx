import { useCallback, useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { DiskUsageResponse, Session, Worktree } from "@/api/types";
import { StatusDot } from "@/components/layout/StatusDot";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { SectionHeader } from "./SectionHeader";
import { SettingsRow } from "./SettingsRow";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { sessionStatus } from "@/lib/worktreeStatus";
import { excludeSuperseded } from "@/lib/sessionVisibility";
import "./settings.css";

interface StorageSettingProps {
  api: ApiInstance;
}

type Filter = "done" | "all";
type Sort = "created" | "disk";

function formatBytes(n: number): string {
  if (n === 0) return "—";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function isWorktreeDone(wt: Worktree, sessions: Session[]): boolean {
  const visible = excludeSuperseded(sessions);
  if (visible.length === 0) return true;
  return visible.every((s) =>
    s.type === "agent"
      ? s.state === "done"
      : s.state === "done" || s.state === "exited",
  );
}

export function StorageSetting({ api }: StorageSettingProps) {
  const [diskUsage, setDiskUsage] = useState<DiskUsageResponse | null>(null);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [sessionsByWorktree, setSessionsByWorktree] = useState<Record<string, Session[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("done");
  const [sort, setSort] = useState<Sort>("created");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<Worktree[] | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [wts, sess, disk] = await Promise.all([
        api.listWorktrees(),
        api.listSessions(),
        api.getDiskUsage(),
      ]);
      const grouped: Record<string, Session[]> = {};
      for (const s of sess) {
        if (s.worktreeId) {
          grouped[s.worktreeId] ??= [];
          grouped[s.worktreeId]!.push(s);
        }
      }
      setWorktrees(wts);
      setSessionsByWorktree(grouped);
      setDiskUsage(disk);
      setError(null);
    } catch {
      setError("Failed to load storage data.");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const doneMap = Object.fromEntries(
    worktrees.map((wt) => [wt.id, isWorktreeDone(wt, sessionsByWorktree[wt.id] ?? [])]),
  );

  const diskMap = Object.fromEntries(
    (diskUsage?.worktrees ?? []).map((w) => [w.id, w.diskBytes]),
  );

  // Apply filter
  const filtered = worktrees.filter((wt) => filter === "all" || doneMap[wt.id]);

  // Apply sort
  const sorted = [...filtered].sort((a, b) => {
    if (sort === "disk") return (diskMap[b.id] ?? 0) - (diskMap[a.id] ?? 0);
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  const hiddenCount = worktrees.length - filtered.length;
  const doneCount = worktrees.filter((wt) => doneMap[wt.id]).length;
  const totalFilteredDisk = filtered.reduce((sum, wt) => sum + (diskMap[wt.id] ?? 0), 0);

  const allDoneVisible = sorted.filter((wt) => doneMap[wt.id]);
  const allChecked =
    allDoneVisible.length > 0 && allDoneVisible.every((wt) => selected.has(wt.id));

  function toggleSelectAll() {
    if (allChecked) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allDoneVisible.map((wt) => wt.id)));
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleDelete(targets: Worktree[]) {
    setDeleteError(null);
    for (const wt of targets) {
      try {
        // enforceDone: this panel only ever offers *done* worktrees for
        // deletion (non-done rows are disabled), and opts into the daemon's
        // 409 `worktree_not_done` safety net in case that state went stale.
        await api.deleteWorktree(wt.id, { enforceDone: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "An error occurred";
        let label = wt.branch;
        try {
          const parsed = JSON.parse(msg) as { error?: string };
          if (parsed.error !== "worktree_not_done") label = msg;
        } catch {
          label = msg;
        }
        setDeleteError(`! "${label}" — deletion cancelled.`);
        break;
      }
    }
    setPendingDelete(null);
    setSelected(new Set());
    setLoading(true);
    await fetchData();
  }

  const selectedWorktrees = worktrees.filter((wt) => selected.has(wt.id));
  const selectedDisk = selectedWorktrees.reduce((sum, wt) => sum + (diskMap[wt.id] ?? 0), 0);

  if (loading) {
    return (
      <div>
        <SectionHeader title="Storage" description="Disk usage and cleanup for worktrees." />
        <div className="settings-state">Calculating disk usage…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <SectionHeader title="Storage" description="Disk usage and cleanup for worktrees." />
        <div className="settings-error selectable" role="alert">{error}</div>
      </div>
    );
  }

  const device = diskUsage?.device;
  const usedPct =
    device && device.totalBytes > 0
      ? Math.min(100, ((device.totalBytes - device.availableBytes) / device.totalBytes) * 100)
      : 0;

  return (
    <div>
      <SectionHeader title="Storage" description="Disk usage and cleanup for worktrees." />

      {device && (
        <SettingsRow
          label="Device disk"
          description={
            <>
              <div className="settings-meter" role="presentation">
                <div className="settings-meter__fill" style={{ width: `${usedPct.toFixed(1)}%` }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-3)" }}>
                <span>{formatBytes(device.totalBytes - device.availableBytes)} / {formatBytes(device.totalBytes)}</span>
                <span>{formatBytes(device.availableBytes)} free</span>
              </div>
            </>
          }
        />
      )}

      <div style={{ marginTop: "var(--space-6)" }}>
        <SectionHeader
          title="Worktrees"
          description={
            filter === "done"
              ? `${doneCount} done worktree${doneCount !== 1 ? "s" : ""} · ${formatBytes(totalFilteredDisk)}`
              : `${filtered.length} worktree${filtered.length !== 1 ? "s" : ""} · ${formatBytes(totalFilteredDisk)}`
          }
        />
      </div>

      <div className="settings-toolbar">
        <label className="settings-check" style={{ width: "auto", gap: "var(--space-2)", fontSize: "var(--font-size-sm)", color: "var(--fg-primary)" }}>
          <input
            type="checkbox"
            checked={allChecked}
            onChange={toggleSelectAll}
            disabled={allDoneVisible.length === 0}
          />
          Select all
        </label>
        <span className="settings-toolbar__group">
          Sort
          <SegmentedControl
            options={[
              { value: "created", label: "Created" },
              { value: "disk", label: "Disk usage" },
            ]}
            value={sort}
            onChange={(v) => setSort(v as Sort)}
          />
        </span>
        <span className="settings-toolbar__group">
          Show
          <SegmentedControl
            options={[
              { value: "done", label: "Done" },
              { value: "all", label: "All" },
            ]}
            value={filter}
            onChange={(v) => { setFilter(v as Filter); setSelected(new Set()); }}
          />
        </span>
      </div>

      {deleteError && (
        <div className="settings-error selectable" role="alert">{deleteError}</div>
      )}

      <div style={{ borderTop: "var(--border-width) solid var(--border-subtle, var(--border-default))" }}>
        {sorted.length === 0 && (
          <div className="settings-state" style={{ textAlign: "center" }}>
            {worktrees.length === 0 || filter === "all"
              ? "No worktrees yet. Worktrees appear here once you spawn an agent."
              : "No done worktrees. Switch to All to see active ones."}
          </div>
        )}

        {sorted.map((wt) => {
          const done = doneMap[wt.id] ?? false;
          const wtSessions = excludeSuperseded(sessionsByWorktree[wt.id] ?? []);
          const mainSession =
            wtSessions.find((s) => s.type === "agent" && s.isMain) ??
            wtSessions.find((s) => s.type === "agent") ??
            wtSessions[0];
          const status = mainSession ? sessionStatus(mainSession.state) : "none";

          return (
            <div
              key={wt.id}
              onClick={done ? () => toggleSelect(wt.id) : undefined}
              className={`settings-row settings-wt-row ${done ? "settings-wt-row--clickable" : "settings-wt-row--disabled"}`}
            >
              <label className="settings-check" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selected.has(wt.id)}
                  onChange={() => toggleSelect(wt.id)}
                  disabled={!done}
                  title={done ? undefined : "Only done worktrees can be deleted"}
                />
              </label>

              <div className="settings-row__main">
                <div className="settings-row__label" style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <StatusDot status={status} />
                  <span className="settings-mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {wt.id} · {wt.branch}
                  </span>
                </div>
                <div className="settings-row__desc">
                  Created {new Date(wt.createdAt).toLocaleDateString()} · {wtSessions.length} session{wtSessions.length !== 1 ? "s" : ""}
                </div>
              </div>

              <div className="settings-row__control">
                <span className="settings-mono" style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-muted)", whiteSpace: "nowrap" }}>
                  {formatBytes(diskMap[wt.id] ?? 0)}
                </span>
                <button
                  type="button"
                  className="icon-btn settings-btn settings-btn--icon"
                  disabled={!done}
                  aria-label={`Delete worktree ${wt.branch}`}
                  title={done ? "Delete worktree" : "Only done worktrees can be deleted"}
                  onClick={(e) => { e.stopPropagation(); setPendingDelete([wt]); }}
                  style={{ opacity: done ? 1 : 0.3, cursor: done ? "pointer" : "not-allowed" }}
                >
                  ×
                </button>
              </div>
            </div>
          );
        })}

        {hiddenCount > 0 && filter === "done" && (
          <div className="settings-state" style={{ textAlign: "center", fontSize: "var(--font-size-xs)" }}>
            {hiddenCount} other{hiddenCount !== 1 ? "s" : ""} hidden by filter
          </div>
        )}
      </div>

      {selected.size > 0 && (
        <div className="settings-footer">
          <span style={{ fontSize: "var(--font-size-sm)", color: "var(--fg-muted)" }}>
            {selected.size} selected ({formatBytes(selectedDisk)})
          </span>
          <button
            type="button"
            className="btn btn--secondary settings-btn settings-btn--danger"
            onClick={() => setPendingDelete(selectedWorktrees)}
          >
            Delete selected
          </button>
        </div>
      )}

      {/* Confirm dialog */}
      <ConfirmDialog
        open={pendingDelete !== null}
        title={
          pendingDelete && pendingDelete.length === 1
            ? "Delete worktree?"
            : `Delete ${pendingDelete?.length ?? 0} worktrees?`
        }
        message={
          pendingDelete
            ? [
                "This will permanently remove:",
                ...pendingDelete.map(
                  (wt) => `• ${wt.branch} (${formatBytes(diskMap[wt.id] ?? 0)})`,
                ),
                "",
                `Total freed: ${formatBytes(pendingDelete.reduce((s, wt) => s + (diskMap[wt.id] ?? 0), 0))}`,
                "",
                "This cannot be undone.",
              ].join("\n")
            : ""
        }
        confirmLabel={pendingDelete?.length === 1 ? "Delete worktree" : "Delete worktrees"}
        onConfirm={() => {
          if (pendingDelete) void handleDelete(pendingDelete);
        }}
        onCancel={() => { setPendingDelete(null); setDeleteError(null); }}
      />
    </div>
  );
}
