interface SpawningPlaceholderProps {
  reason: "spawning" | "reconnecting";
}

export function SpawningPlaceholder({ reason }: SpawningPlaceholderProps) {
  const label = reason === "spawning" ? "Starting…" : "Reconnecting…";
  return (
    <div className="spawning-placeholder" role="status" aria-live="polite" aria-label={label}>
      <span className="spawning-placeholder__dot" aria-hidden />
      <span className="spawning-placeholder__label">{label}</span>
    </div>
  );
}
