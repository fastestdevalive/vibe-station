/**
 * The git-worktree glyph (fork) from the dashboard design frames (`.wt`).
 * Used instead of a lucide folder icon; sized/coloured by `.acard__glyph`.
 */
export function WorktreeGlyph({ className = "acard__glyph" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="5" r="2.5" />
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="12" cy="19" r="2.5" />
      <path d="M6 7.5v2a2.5 2.5 0 0 0 2.5 2.5h7A2.5 2.5 0 0 0 18 9.5v-2M12 12v4.5" />
    </svg>
  );
}
