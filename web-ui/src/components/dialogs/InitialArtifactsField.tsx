import { ImagePlus } from "lucide-react";

/**
 * Creation-time "initial context" dropzone. Lets the user attach images/files
 * (specs, screenshots, sample data) when starting a worktree or agent so the
 * agent has more context up front. On submit these will be copied into the
 * worktree's artifacts directory and referenced in the agent's prompt.
 *
 * Placeholder for now — disabled, no upload wiring yet.
 */
export function InitialArtifactsField() {
  return (
    <>
      <div className="field-label" style={{ marginTop: "var(--space-4)", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        Initial context <span style={{ color: "var(--fg-muted)", fontWeight: "normal" }}>(optional)</span>
        <span className="initial-artifacts__badge">Coming soon</span>
      </div>
      <div className="initial-artifacts" aria-disabled="true" role="group" aria-label="Attach initial context files">
        <ImagePlus size={20} aria-hidden />
        <div className="initial-artifacts__primary">Drop images or files here, or click to browse</div>
        <div className="initial-artifacts__hint">
          Added to this worktree’s <strong>artifacts</strong> and shared with the agent as starting context.
        </div>
      </div>
    </>
  );
}
