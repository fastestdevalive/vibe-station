import { useCallback, useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { DiskUsageResponse, Session, Worktree } from "@/api/types";
import { StatusDot } from "@/components/layout/StatusDot";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { sessionStatus } from "@/lib/worktreeStatus";

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
  if (sessions.length === 0) return true;
  return sessions.every((s) =>
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
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  const hiddenCount = worktrees.length - filtered.length;
  const doneCount = worktrees.filter((wt) => doneMap[wt.id]).length;
  const totalFilteredDisk = filtered.reduce((sum, wt) => sum + (diskMap[wt.id] ?? 0), 0);

  const maxDisk = Math.max(1, ...filtered.map((wt) => diskMap[wt.id] ?? 0));

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
        await api.deleteWorktree(wt.id);
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
      <div style={{ padding: "var(--space-5)", color: "var(--fg-muted)" }}>
        Calculating disk usage…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: "var(--space-5)", color: "var(--fg-danger)" }}>{error}</div>
    );
  }

  const device = diskUsage?.device;

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4)",
        overflow: "hidden",
      }}
    >
      {/* Device disk bar */}
      {device && (
        <div
          style={{
            border: "var(--border-width) solid var(--border-default)",
            borderRadius: "var(--radius-md)",
            background: "var(--bg-card)",
            padding: "var(--space-3) var(--space-4)",
          }}
        >
          <div style={{ fontSize: "var(--font-size-sm)", fontWeight: "var(--font-weight-medium)", marginBottom: "var(--space-2)" }}>
            Device disk
          </div>
          <div
            style={{
              height: 8,
              borderRadius: 4,
              background: "var(--bg-input)",
              overflow: "hidden",
              marginBottom: "var(--space-2)",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${Math.min(100, (device.usedBytes / device.totalBytes) * 100).toFixed(1)}%`,
                background: "var(--fg-accent)",
                borderRadius: 4,
              }}
            />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--font-size-xs)", color: "var(--fg-muted)" }}>
            <span>{formatBytes(device.usedBytes)} / {formatBytes(device.totalBytes)}</span>
            <span>{formatBytes(device.availableBytes)} free</span>
          </div>
        </div>
      )}

      {/* Section header */}
      <div style={{ borderBottom: "var(--border-width) solid var(--border-default)", paddingBottom: "var(--space-2)" }}>
        <span style={{ fontSize: "var(--font-size-xs)", fontWeight: "var(--font-weight-medium)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--fg-muted)" }}>
          Worktrees
        </span>
      </div>

      {/* Controls bar */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--font-size-sm)", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={allChecked}
            onChange={toggleSelectAll}
            disabled={allDoneVisible.length === 0}
          />
          Select all
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--font-size-sm)" }}>
          Sort:
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            style={{ font: "inherit", fontSize: "var(--font-size-sm)", background: "var(--bg-input)", border: "var(--border-width) solid var(--border-default)", borderRadius: "var(--radius-sm)", padding: "2px var(--space-2)" }}
          >
            <option value="created">Creation date ↓</option>
            <option value="disk">Disk usage ↓</option>
          </select>
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--font-size-sm)" }}>
          Show:
          <select
            value={filter}
            onChange={(e) => { setFilter(e.target.value as Filter); setSelected(new Set()); }}
            style={{ font: "inherit", fontSize: "var(--font-size-sm)", background: "var(--bg-input)", border: "var(--border-width) solid var(--border-default)", borderRadius: "var(--radius-sm)", padding: "2px var(--space-2)" }}
          >
            <option value="done">Done</option>
            <option value="all">All</option>
          </select>
        </label>

        <span style={{ marginLeft: "auto", fontSize: "var(--font-size-xs)", color: "var(--fg-muted)" }}>
          {filter === "done"
            ? `${doneCount} done worktree${doneCount !== 1 ? "s" : ""} · ${formatBytes(totalFilteredDisk)}`
            : `${filtered.length} worktree${filtered.length !== 1 ? "s" : ""} · ${formatBytes(totalFilteredDisk)}`}
        </span>
      </div>

      {deleteError && (
        <div style={{ padding: "var(--space-2) var(--space-3)", background: "var(--bg-danger-subtle, var(--bg-input))", border: "var(--border-width) solid var(--border-danger, var(--border-default))", borderRadius: "var(--radius-sm)", fontSize: "var(--font-size-sm)", color: "var(--fg-danger)" }}>
          {deleteError}
        </div>
      )}

      {/* Worktree list */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        {sorted.length === 0 && filter === "done" && (
          <div style={{ padding: "var(--space-5)", textAlign: "center", color: "var(--fg-muted)", fontSize: "var(--font-size-sm)" }}>
            {worktrees.length === 0
              ? "No worktrees yet. Worktrees appear here once you spawn an agent."
              : "No done worktrees. Switch to All to see active ones."}
          </div>
        )}
        {sorted.length === 0 && filter === "all" && (
          <div style={{ padding: "var(--space-5)", textAlign: "center", color: "var(--fg-muted)", fontSize: "var(--font-size-sm)" }}>
            No worktrees yet. Worktrees appear here once you spawn an agent.
          </div>
        )}

        {sorted.map((wt) => {
          const done = doneMap[wt.id] ?? false;
          const bytes = diskMap[wt.id] ?? 0;
          const barPct = Math.min(100, (bytes / maxDisk) * 100);
          const wtSessions = sessionsByWorktree[wt.id] ?? [];
          const mainSession = wtSessions.find((s) => s.type === "agent") ?? wtSessions[0];
          const status = mainSession ? sessionStatus(mainSession.state) : "none";

          return (
            <div
              key={wt.id}
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr auto",
                alignItems: "center",
                gap: "var(--space-3)",
                padding: "var(--space-3)",
                border: "var(--border-width) solid var(--border-default)",
                borderRadius: "var(--radius-md)",
                background: "var(--bg-card)",
                opacity: done ? 1 : 0.7,
              }}
            >
              <input
                type="checkbox"
                checked={selected.has(wt.id)}
                onChange={() => toggleSelect(wt.id)}
                disabled={!done}
                title={done ? undefined : "Only done worktrees can be deleted"}
              />

              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-1)" }}>
                  <StatusDot status={status} />
                  <span style={{ fontWeight: "var(--font-weight-medium)", fontSize: "var(--font-size-sm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {wt.id} · {wt.branch}
                  </span>
                </div>
                <div style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-muted)", marginBottom: "var(--space-1)" }}>
                  Created {new Date(wt.createdAt).toLocaleDateString()} · {wtSessions.length} session{wtSessions.length !== 1 ? "s" : ""}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <div style={{ flex: 1, height: 4, borderRadius: 2, background: "var(--bg-input)", overflow: "hidden", maxWidth: 120 }}>
                    <div style={{ height: "100%", width: `${barPct.toFixed(1)}%`, background: "var(--fg-accent)", borderRadius: 2 }} />
                  </div>
                  <span style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-muted)", whiteSpace: "nowrap" }}>
                    {formatBytes(bytes)}
                  </span>
                </div>
              </div>

              <button
                type="button"
                className="icon-btn"
                disabled={!done}
                title={done ? "Delete worktree" : "Only done worktrees can be deleted"}
                onClick={() => setPendingDelete([wt])}
                style={{ opacity: done ? 1 : 0.3, cursor: done ? "pointer" : "not-allowed" }}
              >
                ×
              </button>
            </div>
          );
        })}

        {hiddenCount > 0 && filter === "done" && (
          <div style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-muted)", textAlign: "center", padding: "var(--space-2)" }}>
            {hiddenCount} other{hiddenCount !== 1 ? "s" : ""} hidden by filter
          </div>
        )}
      </div>

      {/* Bulk delete footer */}
      {selected.size > 0 && (
        <div
          style={{
            borderTop: "var(--border-width) solid var(--border-default)",
            paddingTop: "var(--space-3)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: "var(--font-size-sm)", color: "var(--fg-muted)" }}>
            {selected.size} selected ({formatBytes(selectedDisk)})
          </span>
          <button
            type="button"
            className="btn btn--danger"
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
