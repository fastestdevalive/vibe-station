import { useEffect, useState, type ReactNode } from "react";
import { FileText, Folder, X } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { ArtifactRow, FileStat, GitStatusChar, Session } from "@/api/types";
import { formatBytes } from "@/components/artifacts/formatBytes";
import { DELETED_AGENT_LABEL, writerLabel } from "@/components/artifacts/artifactSessions";
import { languageForFilePath } from "@/components/preview/codeHighlight";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { usePortalRoot } from "@/context/DemoEnv";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useServerStore } from "@/hooks/useServerStore";
import { formatFullTimestamp, formatTimeAgo } from "@/lib/timeAgo";
import { copyText } from "@/lib/copyText";
import { createPortal } from "react-dom";
import { resolveCopyPath } from "./copyPath";
import type { DetailsTarget } from "./detailsStore";
import "./details.css";

const GIT_LABEL: Record<GitStatusChar, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  "?": "Untracked",
};

const UNAVAILABLE = "unavailable";
const LOADING = "…";

function editsText(n: number): string {
  return n === 1 ? "1 edit" : `${n} edits`;
}

const TYPE_BY_EXT: Record<string, string> = {
  html: "HTML", htm: "HTML", css: "CSS", json: "JSON", md: "Markdown",
  ts: "TypeScript", tsx: "TypeScript (TSX)", js: "JavaScript", jsx: "JavaScript (JSX)",
  rs: "Rust", py: "Python", sh: "Shell", yml: "YAML", yaml: "YAML", toml: "TOML",
  svg: "SVG", png: "PNG image", jpg: "JPEG image", jpeg: "JPEG image", gif: "GIF image",
  webp: "WebP image", pdf: "PDF", txt: "Text",
};

/** Type column: a folder, a known extension's label, the language of a known text file, else the extension, else "File". */
export function typeLabel(target: DetailsTarget, stat: FileStat | null): string {
  if (target.isDir || stat?.kind === "dir") return "Folder";
  const dot0 = target.name.lastIndexOf(".");
  const known = dot0 > 0 ? TYPE_BY_EXT[target.name.slice(dot0 + 1).toLowerCase()] : undefined;
  if (known) return known;
  const lang = languageForFilePath(target.name);
  if (lang) return lang.charAt(0).toUpperCase() + lang.slice(1);
  const dot = target.name.lastIndexOf(".");
  return dot > 0 ? target.name.slice(dot + 1).toUpperCase() : "File";
}

interface FileDetailsDialogProps {
  api: Pick<ApiInstance, "statPath">;
  target: DetailsTarget;
  onClose: () => void;
}

/**
 * The Details popup (desktop) or bottom sheet (phones), tools-pane-rework B7.3. Facts come from the stat route (one
 * request per open; a response for an earlier target is ignored) and from the row (path, git, artifact writers and
 * edits). A failed stat keeps the row facts and shows "unavailable" for size and modified.
 */
export function FileDetailsDialog({ api, target, onClose }: FileDetailsDialogProps) {
  const mobile = useIsMobile();
  const portalRoot = usePortalRoot();
  const sessions = useServerStore((s) => s.sessions);
  const [stat, setStat] = useState<FileStat | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let live = true;
    setStat(null);
    setStatus("loading");
    api.statPath(target.scopeId, target.path, target.scope, target.artifact?.id).then(
      (s) => {
        if (!live) return;
        setStat(s);
        setStatus("ready");
      },
      () => {
        if (live) setStatus("error");
      },
    );
    return () => {
      live = false;
    };
  }, [api, target]);

  // Esc closes the desktop popup (the sheet handles its own Esc).
  useEffect(() => {
    if (mobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobile, onClose]);

  const artifact: ArtifactRow | undefined = target.artifact;
  const byId = new Map<string, Session>(sessions.map((s) => [s.id, s]));
  const pathText = stat?.absolutePath ?? (artifact?.displayPath ?? target.path);
  const sizeText =
    status === "loading"
      ? LOADING
      : status === "error"
        ? UNAVAILABLE
        : stat?.size != null
          ? `${formatBytes(stat.size)}${stat.lineCount != null ? ` · ${stat.lineCount} ${stat.lineCount === 1 ? "line" : "lines"}` : ""}`
          : "—";
  const modifiedText =
    status === "loading" ? LOADING : status === "error" ? UNAVAILABLE : stat?.modifiedMs != null ? modifiedWithAge(stat.modifiedMs) : "—";

  const rows: Array<[string, ReactNode]> = [];
  rows.push([
    "Path",
    <span className="file-details__path-row">
      <span className="file-details__value file-details__path">{pathText}</span>
      <button
        type="button"
        className="file-details__copy"
        aria-label="Copy path"
        // Synchronous, with the already-loaded stat (no await before the clipboard write).
        onClick={() => void copyText(resolveCopyPath(target, stat))}
      >
        Copy
      </button>
    </span>,
  ]);
  if (artifact && !artifact.inRepo) rows.push(["Location", "Outside the repo"]);
  rows.push(["Type", typeLabel(target, stat)]);
  rows.push(["Size", sizeText]);
  rows.push(["Modified", modifiedText]);
  if (target.git) {
    const g = target.git;
    const counts = [g.insertions ? `+${g.insertions}` : null, g.deletions ? `−${g.deletions}` : null].filter(Boolean).join(" ");
    rows.push(["Git", `${GIT_LABEL[g.status]}${counts ? `, ${counts}` : ""} vs ${g.baseLabel ?? "HEAD"}`]);
  }
  if (artifact) {
    rows.push(["Written by", writerLabel(artifact, byId) ?? DELETED_AGENT_LABEL]);
    rows.push(["Edits", editsText(artifact.editCount)]);
  }

  const content = (
    <div className="file-details">
      <div className="file-details__head">
        {typeLabel(target, stat) === "Folder" ? (
          <Folder size={14} aria-hidden="true" className="file-details__icon" />
        ) : (
          <FileText size={14} aria-hidden="true" className="file-details__icon" />
        )}
        <span className="file-details__title">{target.name}</span>
        {mobile ? null : (
          <button type="button" className="file-details__close" aria-label="Close" autoFocus onClick={onClose}>
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      <dl className="file-details__list">
        {rows.map(([label, value]) => (
          <div className="file-details__row" key={label}>
            <dt className="file-details__label">{label}</dt>
            <dd className="file-details__value-cell">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );

  if (mobile) {
    return (
      <BottomSheet open onClose={onClose} label="Details">
        {content}
      </BottomSheet>
    );
  }
  return createPortal(
    <div className="file-details-backdrop" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Details" className="file-details-popup" onMouseDown={(e) => e.stopPropagation()}>
        {content}
      </div>
    </div>,
    portalRoot,
  );
}

/** "Today 09:12 (2h ago)" style: the full timestamp, then the short age. */
function modifiedWithAge(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${formatFullTimestamp(iso)} (${formatTimeAgo(iso)} ago)`;
}
