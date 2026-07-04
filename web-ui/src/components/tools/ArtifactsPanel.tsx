import { useState } from "react";
import { Copy, Download, FileText, FolderUp, Image as ImageIcon, Package, Trash2, Upload } from "lucide-react";

/**
 * Artifacts tool — files the agent produced outside the worktree (screenshots,
 * logs, captures) plus user uploads. Master-detail: a list on the left; tapping
 * an item opens an in-place detail view (image lightbox / text viewer) with
 * Download / Copy path / Delete. Backend + upload wiring land later — the items
 * and actions below are placeholders that establish the interaction.
 */
type ArtifactKind = "image" | "text" | "binary";
interface ArtifactItem {
  id: string;
  name: string;
  kind: ArtifactKind;
  size: string;
  when: string;
  source: string;
}

const SAMPLE: ArtifactItem[] = [
  { id: "1", name: "login-screen.png", kind: "image", size: "248 KB", when: "2m ago", source: "main" },
  { id: "2", name: "adb-logcat.txt", kind: "text", size: "12 KB", when: "5m ago", source: "agent 1" },
  { id: "3", name: "coverage.json", kind: "text", size: "31 KB", when: "12m ago", source: "main" },
];

function kindIcon(kind: ArtifactKind) {
  if (kind === "image") return <ImageIcon size={14} aria-hidden />;
  return <FileText size={14} aria-hidden />;
}

export function ArtifactsPanel() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const items = SAMPLE;
  const selected = items.find((a) => a.id === selectedId) ?? null;

  return (
    <div className="artifacts-panel">
      <div className="artifacts-panel__bar">
        <span className="artifacts-panel__badge">Coming soon</span>
        <div className="artifacts-panel__upload">
          <button type="button" className="artifacts-upload__btn" disabled title="Upload a file (coming soon)">
            <Upload size={14} /> Upload file
          </button>
          <button type="button" className="artifacts-upload__btn" disabled title="Upload a folder (coming soon)">
            <FolderUp size={14} /> Upload folder
          </button>
        </div>
      </div>
      <div className="artifacts-panel__split">
        <ul className="artifacts-list" role="listbox" aria-label="Artifacts">
          {items.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                role="option"
                aria-selected={a.id === selectedId}
                data-active={a.id === selectedId}
                className="artifacts-list__row"
                onClick={() => setSelectedId(a.id)}
              >
                <span className="artifacts-list__icon">{kindIcon(a.kind)}</span>
                <span className="artifacts-list__name">{a.name}</span>
                <span className="artifacts-list__meta">{a.size} · {a.when} · {a.source}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="artifacts-detail">
          {selected ? (
            <>
              <div className="artifacts-detail__head">
                <span className="artifacts-detail__title">{selected.name}</span>
                <div className="artifacts-detail__actions">
                  <button type="button" className="artifacts-detail__btn" disabled title="Download (coming soon)">
                    <Download size={14} />
                  </button>
                  <button type="button" className="artifacts-detail__btn" disabled title="Copy path (coming soon)">
                    <Copy size={14} />
                  </button>
                  <button type="button" className="artifacts-detail__btn" disabled title="Delete (coming soon)">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <div className="artifacts-detail__view">
                {selected.kind === "image" ? (
                  <div className="artifacts-detail__image-ph" aria-hidden>
                    <ImageIcon size={32} />
                    <span>Image preview</span>
                  </div>
                ) : (
                  <pre className="artifacts-detail__text-ph" aria-hidden>{`// ${selected.name}\n// text/log preview renders here`}</pre>
                )}
              </div>
            </>
          ) : (
            <div className="artifacts-detail__empty">
              <Package size={28} aria-hidden />
              <p>Select an artifact to preview it here. Tapping opens an image lightbox or text viewer with download, copy-path, and delete.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
