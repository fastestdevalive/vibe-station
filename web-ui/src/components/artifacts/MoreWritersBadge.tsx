interface MoreWritersBadgeProps {
  count: number;
  names?: string;
}

export function MoreWritersBadge({ count, names }: MoreWritersBadgeProps) {
  if (count <= 0) return null;
  return (
    <span
      role="img"
      className="artifacts-row__more-writers"
      title={names}
      aria-label={names ? `and ${count} more: ${names}` : `and ${count} more`}
    >
      +{count}
    </span>
  );
}
