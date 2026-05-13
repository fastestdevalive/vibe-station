/**
 * Brand mark — a hub node forking into three parallel branches that each
 * land on a satellite commit. Renders in `currentColor` so it inherits
 * the surrounding text color in both light and dark themes.
 */
export function Logo({
  size = 18,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="14" cy="32" r="6" fill="currentColor" stroke="none" />
      <path d="M20 32 H28 L38 18 H50" />
      <path d="M20 32 H56" />
      <path d="M20 32 H28 L38 46 H50" />
      <circle cx="50" cy="18" r="3.5" fill="currentColor" stroke="none" />
      <circle cx="56" cy="32" r="3.5" fill="currentColor" stroke="none" />
      <circle cx="50" cy="46" r="3.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
