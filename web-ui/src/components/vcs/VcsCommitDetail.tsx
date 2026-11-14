import { ChevronDown, ChevronUp } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import type { ApiInstance } from "@/api";
import type { ChangedPathEntry, CommitLogEntry, FileScope } from "@/api/types";
import { ChangedFileList } from "@/components/layout/ChangedFileList";
import { RailHeader } from "@/components/layout/RailHeader";
import { relativeTime } from "@/components/tools/VcsCommitRow";
import { copyText } from "@/lib/copyText";

export interface VcsCommitDetailProps {
  api: Pick<ApiInstance, "statPath">;
  /** The worktree (or project) the commit belongs to: Details of its files resolve against it. */
  scopeId: string;
  scope: FileScope;
  /** The commit's list entry when it is in the cache (subject, author, totals); null otherwise. */
  commit: CommitLogEntry | null;
  sha: string;
  /** Changed files of this commit (`VcsPanel` owns the fetch and the per-sha cache). */
  entries: ChangedPathEntry[];
  filesLoading: boolean;
  filesError: string | null;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
  /** Older = the next entry of the list in scope; newer = the previous one. */
  canOlder: boolean;
  canNewer: boolean;
  onOlder: () => void;
  onNewer: () => void;
  /** Back to the commit list level ("Commits" button; Esc in the files list). */
  onUp: () => void;
}

/**
 * Level 2 of the docked sidebar (board 3): `‹ Commits` and older/newer on the header, then the commit's subject,
 * author · time · sha (click copies), totals, an expandable message and the changed files. `]` = older,
 * `[` = newer (focus inside the sidebar); Esc in the files list = up. The diff pane stays where it is.
 */
export function VcsCommitDetail({
  api,
  scopeId,
  scope,
  commit,
  sha,
  entries,
  filesLoading,
  filesError,
  selectedPath,
  onSelectPath,
  canOlder,
  canNewer,
  onOlder,
  onNewer,
  onUp,
}: VcsCommitDetailProps) {
  const [messageOpen, setMessageOpen] = useState(false);
  const shortSha = sha.slice(0, 7);
  const hasBody = commit != null && commit.body.trim() !== "" && commit.body.trim() !== commit.subject.trim();

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "]" && canOlder) {
      e.preventDefault();
      onOlder();
    } else if (e.key === "[" && canNewer) {
      e.preventDefault();
      onNewer();
    }
  };

  const onFilesKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") onUp();
  };

  return (
    <div className="vcs-commit-detail" onKeyDown={onKeyDown}>
      <RailHeader
        mode="commit"
        className="vcs-commit-detail__head"
        left={
          <button type="button" className="vcs-commit-detail__up" onClick={onUp}>
            <span aria-hidden="true">‹</span> Commits
          </button>
        }
        right={
          <>
            <button
              type="button"
              className="rail-header__ib"
              aria-label="Older commit"
              title="Older commit ( ] )"
              disabled={!canOlder}
              onClick={onOlder}
            >
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="rail-header__ib"
              aria-label="Newer commit"
              title="Newer commit ( [ )"
              disabled={!canNewer}
              onClick={onNewer}
            >
              <ChevronUp size={14} aria-hidden="true" />
            </button>
          </>
        }
      />
      <div className="vcs-commit-detail__body">
        <div className="vcs-commit-detail__subject">{commit?.subject || shortSha}</div>
        <div className="vcs-commit-detail__meta">
          {commit ? (
            <>
              <span>{commit.authorName}</span>
              <span aria-hidden="true">·</span>
              <span title={commit.date}>{relativeTime(commit.date)}</span>
              <span aria-hidden="true">·</span>
            </>
          ) : null}
          <button
            type="button"
            className="vcs-commit-detail__sha"
            title={sha}
            // Synchronous copy in the click handler (the clipboard write stays inside the user gesture).
            onClick={() => void copyText(sha)}
          >
            {shortSha}
          </button>
        </div>
        {commit ? (
          <div className="vcs-commit-detail__totals">
            <span className="vcs-row__add">+{commit.insertions}</span>
            <span className="vcs-row__del">−{commit.deletions}</span>
          </div>
        ) : null}
        {hasBody ? (
          <div className="vcs-commit-detail__message-block">
            <button
              type="button"
              className="vcs-commit-detail__message-toggle"
              aria-expanded={messageOpen}
              onClick={() => setMessageOpen((v) => !v)}
            >
              Message
            </button>
            {messageOpen ? <pre className="vcs-commit-detail__message">{commit?.body}</pre> : null}
          </div>
        ) : null}
        <div className="vcs-commit-detail__files-head">
          Files{!filesLoading && !filesError ? ` ${entries.length}` : ""}
        </div>
        <div className="vcs-commit-detail__files" onKeyDown={onFilesKeyDown}>
          <ChangedFileList
            entries={entries}
            loading={filesLoading}
            error={filesError}
            controlled={{ activePath: selectedPath, onSelect: onSelectPath }}
            api={api}
            detailsScope={{ scope, scopeId, baseLabel: "commit" }}
          />
        </div>
      </div>
    </div>
  );
}
