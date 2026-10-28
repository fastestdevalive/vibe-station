import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ArtifactReadError } from "@/api/errors";
import { formatBytes } from "./formatBytes";

/** What a failed or absent artifact read renders (`ArtifactStates.dc.html` frame 7, `.empty` pattern). */
export type ArtifactPanelState =
  | { kind: "evicted" }
  | { kind: "listError"; message: string }
  | { kind: "missing" }
  | { kind: "unreadable"; detail?: string; denied?: boolean }
  | { kind: "binary"; size?: number; mime?: string }
  | { kind: "tooLarge"; size?: number };

/** Map a failed `getArtifactContent` to a panel; `null` means a generic error (rendered as plain text). */
export function panelForReadError(e: unknown): ArtifactPanelState | null {
  if (!(e instanceof ArtifactReadError)) return null;
  switch (e.code) {
    case "ARTIFACT_NOT_FOUND":
      return { kind: "evicted" };
    case "ARTIFACT_MISSING":
      return { kind: "missing" };
    case "ARTIFACT_UNREADABLE":
      return { kind: "unreadable", detail: e.info.detail };
    case "ARTIFACT_DENIED":
      return { kind: "unreadable", denied: true };
    case "ARTIFACT_BINARY":
      return { kind: "binary", size: e.info.size, mime: e.info.mime };
    case "ARTIFACT_TOO_LARGE":
      return { kind: "tooLarge", size: e.info.size };
    default:
      return null;
  }
}

interface ArtifactStatePanelProps {
  state: ArtifactPanelState;
  onCopyPath: () => void;
  onCloseTab?: () => void;
  /** Missing only: hide the row from the list. */
  onRemove?: () => void;
  /** List-fetch error only: fetch the artifacts list again. */
  onRetry?: () => void;
}

/** The full-pane state for an artifact that cannot be previewed. */
export function ArtifactStatePanel({ state, onCopyPath, onCloseTab, onRemove, onRetry }: ArtifactStatePanelProps) {
  const copy = (
    <Button size="sm" onClick={onCopyPath}>
      Copy path
    </Button>
  );
  switch (state.kind) {
    case "evicted":
      return (
        <EmptyState
          className="artifact-state"
          title="No longer an artifact"
          actions={
            <>
              {copy}
              {onCloseTab ? (
                <Button size="sm" onClick={onCloseTab}>
                  Close tab
                </Button>
              ) : null}
            </>
          }
        >
          This file was dropped from the list. It can’t be opened here until an agent writes it again.
        </EmptyState>
      );
    case "listError":
      return (
        <EmptyState
          className="artifact-state"
          title="Couldn’t load artifacts"
          actions={
            <>
              {onRetry ? (
                <Button size="sm" onClick={onRetry}>
                  Retry
                </Button>
              ) : null}
              {copy}
            </>
          }
        >
          {state.message}
        </EmptyState>
      );
    case "missing":
      return (
        <EmptyState
          className="artifact-state"
          title="File not found"
          actions={
            <>
              {copy}
              {onRemove ? (
                <Button size="sm" onClick={onRemove}>
                  Remove
                </Button>
              ) : null}
            </>
          }
        >
          This file was deleted or moved.
        </EmptyState>
      );
    case "unreadable":
      return (
        <EmptyState className="artifact-state" title="Can’t read this file" actions={copy}>
          {state.denied
            ? "This file is blocked from preview."
            : `Permission denied${state.detail ? ` (${state.detail})` : ""}.`}
        </EmptyState>
      );
    case "binary": {
      const bits = [state.size != null ? formatBytes(state.size) : null, state.mime ?? null].filter(Boolean);
      return (
        <EmptyState className="artifact-state" title="Binary file" actions={copy}>
          {`No preview.${bits.length ? ` ${bits.join(" · ")}` : ""}`}
        </EmptyState>
      );
    }
    case "tooLarge":
      return (
        <EmptyState className="artifact-state" title="Too large to preview" actions={copy}>
          {state.size != null ? formatBytes(state.size) : "This file is too large."}
        </EmptyState>
      );
  }
}

/** The daemon cuts a text artifact at 1 MiB (mirrors vst-artifacts). */
const TRUNCATE_BYTES = 1_048_576;

interface TruncatedBannerProps {
  total: number;
  onCopyPath: () => void;
}

/** Warn banner above a text artifact the daemon cut at 1 MiB. */
export function TruncatedBanner({ total, onCopyPath }: TruncatedBannerProps) {
  const shownLabel = formatBytes(TRUNCATE_BYTES);
  // A file just over the cut would read "1 MB of 1 MB": fall back to the exact byte count.
  const totalLabel = formatBytes(total) === shownLabel ? `${total.toLocaleString("en-US")} bytes` : formatBytes(total);
  return (
    <Banner
      tone="warn"
      actions={
        <Button size="sm" onClick={onCopyPath}>
          Copy path
        </Button>
      }
    >
      Showing the first {shownLabel} of {totalLabel}
    </Banner>
  );
}
