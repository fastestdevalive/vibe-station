import type { ReactNode } from "react";
import "./picker.css";

/**
 * The ONE disclosure used by the background Picker (Wallpaper / Texture) and by
 * Settings' Visibility section. A real `<button>` inside the `h3`, so Enter and
 * Space open it natively; `aria-expanded`/`aria-controls` point at the region.
 */
export interface CollapsibleSectionProps {
  /** Region id; the header button gets `aria-controls={id}`. */
  id: string;
  title: string;
  /** Current value shown in the closed row. */
  summary?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

export function CollapsibleSection({
  id,
  title,
  summary,
  open,
  onToggle,
  children,
}: CollapsibleSectionProps): React.JSX.Element {
  const headId = `${id}-head`;
  return (
    <section className="wp-section">
      <h3 className="wp-section__h">
        <button
          type="button"
          id={headId}
          className="wp-section__head"
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
        >
          <span className="wp-section__label">{title}</span>
          {summary !== undefined ? <span className="wp-section__val">{summary}</span> : null}
          <svg
            className="wp-section__chev"
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </h3>
      <div id={id} role="region" aria-labelledby={headId} className="wp-section__body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
