import { useState } from "react";
import { motion } from "framer-motion";
import type { ApiInstance } from "@/api";
import { Input } from "@/components/ui/Input";
import { FolderChooserDialog } from "@/components/dialogs/FolderChooserDialog";
import { Logo } from "@/components/shared/Logo";

/** Inline-code styling for the vst-home/worktrees note below — this app's
 *  base font is already monospace (`--font-family: var(--font-mono)`), so a
 *  bare `<code>` wouldn't visually stand out; a subtle background does. */
const CODE_STYLE = {
  background: "var(--bg-input)",
  border: "var(--border-width) solid var(--border-default)",
  borderRadius: "var(--radius-sm)",
  padding: "1px 4px",
};

interface OobeStep1LocationProps {
  api: ApiInstance;
  defaultProjectsDir: string;
  vstHome: string;
  onConfirmed: (dir: string) => void;
}

/**
 * Entrance sequence for the very first thing a new user sees: the mark rises
 * and fades in first, then the product name, then the tagline — each beat
 * waiting for the previous one to be most of the way through its own
 * transition (`delay`) rather than firing all at once, so the reveal reads as
 * a sequence instead of a single blob fading in.
 */
function OobeWelcomeHeader() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-5)" }}>
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      >
        <Logo size={40} className="oobe-welcome-logo" />
      </motion.div>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut", delay: 0.35 }}
        style={{ fontSize: "var(--font-size-lg)", fontWeight: "var(--font-weight-medium)", color: "var(--fg-primary)" }}
      >
        vibe-station
      </motion.div>
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut", delay: 0.65 }}
        style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-muted)" }}
      >
        Vibe code in parallel. Ship at scale.
      </motion.div>
    </div>
  );
}

export function OobeStep1Location({ api, defaultProjectsDir, vstHome, onConfirmed }: OobeStep1LocationProps) {
  const [path, setPath] = useState(defaultProjectsDir);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleNext() {
    setError(null);
    setBusy(true);
    try {
      const res = await api.confirmOobeStep1(path);
      onConfirmed(res.defaultProjectsDir);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="oobe-step1" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <OobeWelcomeHeader />
      {/* Everything below stays invisible until the welcome header's own
          icon → name → tagline sequence has mostly finished (tagline starts
          at 0.65s, runs 0.4s) — so the form doesn't compete with the brand
          reveal for attention on first paint. */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, ease: "easeOut", delay: 1.0 }}
        style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
      >
        <div className="field-label">Where should projects live by default?</div>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            aria-label="Default projects directory"
            placeholder="/home/you/projects"
            data-testid="oobe-step1-path"
          />
          <button type="button" onClick={() => setBrowseOpen(true)} className="btn btn--secondary">
            Browse
          </button>
        </div>
        {vstHome ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            <p style={{ margin: 0, fontSize: "var(--font-size-xs)", color: "var(--fg-muted)", lineHeight: 1.5 }}>
              This is just where new projects get created by default — you can always pick a
              different folder per project later.
            </p>
            <div
              style={{
                padding: "var(--space-3)",
                borderRadius: "var(--radius-sm)",
                border: "var(--border-width) solid var(--border-default)",
                background: "var(--bg-input)",
              }}
            >
              <p style={{ margin: 0, fontSize: "var(--font-size-xs)", color: "var(--fg-secondary)", lineHeight: 1.5 }}>
                vibe-station&apos;s own config lives separately at{" "}
                <code style={CODE_STYLE}>{vstHome}</code>, and that&apos;s also where every
                project&apos;s worktrees are created (under{" "}
                <code style={CODE_STYLE}>{vstHome}/projects/&lt;project&gt;/worktrees/</code>), not
                inside this directory.
              </p>
            </div>
          </div>
        ) : null}
        {error ? (
          <div className="field-error" data-testid="oobe-step1-error">
            {error}
          </div>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={() => void handleNext()}
            disabled={busy}
            className="btn btn--primary"
          >
            Next
          </button>
        </div>
      </motion.div>
      <FolderChooserDialog
        open={browseOpen}
        onClose={() => setBrowseOpen(false)}
        onSelect={(p) => setPath(p)}
        api={api}
        initialPath={path || "/"}
      />
    </div>
  );
}
