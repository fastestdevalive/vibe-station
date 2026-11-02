import { useRef, type ReactNode } from "react";
import { MotionConfig, motion } from "framer-motion";
import { stableActivityOrder } from "@/lib/sessionActivity";
import { useHoverFrozenOrder } from "@/hooks/useHoverFrozenOrder";

interface DashboardCardGroupProps<T> {
  items: T[];
  idOf: (item: T) => string;
  /** Last-activity ISO timestamp; drives the 3-minute-hysteresis ordering. */
  activityOf: (item: T) => string | null | undefined;
  renderItem: (item: T) => ReactNode;
  /** Cards shown before "More (+N)". Default 10. */
  limit?: number;
  expanded: boolean;
  onExpand: () => void;
  /** Wrapper element: a list `<section>` or a kanban column `<div>`. */
  as?: "section" | "div";
  className: string;
  header: ReactNode;
}

/**
 * One dashboard section / kanban column. Owns the hover-stable ordering (the
 * hook can't live in a render helper) and the 10-card cap: while the pointer is
 * over the group the card order is frozen so activity re-sorts never move a
 * card out from under the cursor; it re-sorts on pointer leave. Order is
 * newest-activity-first with hysteresis (`stableActivityOrder`): cards within
 * 3 minutes of each other keep their place, and moves animate (FLIP).
 */
export function DashboardCardGroup<T>({
  items,
  idOf,
  activityOf,
  renderItem,
  limit = 10,
  expanded,
  onExpand,
  as: Tag = "div",
  className,
  header,
}: DashboardCardGroupProps<T>) {
  const prevIds = useRef<string[]>([]);
  const stable = stableActivityOrder(items, idOf, activityOf, prevIds.current);
  const ids = stable.map(idOf);
  prevIds.current = ids;
  const { order, hoverProps } = useHoverFrozenOrder(ids);
  const byId = new Map(items.map((item) => [idOf(item), item]));
  const ordered = order
    .map((id) => byId.get(id))
    .filter((x): x is T => x !== undefined);
  const visible = expanded ? ordered : ordered.slice(0, limit);
  const hasMore = ordered.length > limit && !expanded;
  // framer-motion re-measures every `layout` element on EVERY render unless a
  // `layoutDependency` is given — a forced page relayout per render, and this
  // component re-renders on every `session:*` frame. Keying the dependency on
  // the visible card order means cards are only measured (and animated) when a
  // card is added, removed or reordered. Trade-off: a card nudged by a
  // sibling merely changing height now snaps instead of tweening, and so do
  // other sections in the list view that are shifted by a card moving between
  // two sections (each group has its own key).
  const layoutKey = visible.map(idOf).join("\u0000");

  return (
    <Tag className={className} {...hoverProps}>
      {header}
      <MotionConfig reducedMotion="user">
        <div className="dashboard-card-list">
          {visible.map((item) => (
            <motion.div
              key={idOf(item)}
              layout="position"
              layoutDependency={layoutKey}
              transition={{ duration: 0.25, ease: "easeOut" }}
            >
              {renderItem(item)}
            </motion.div>
          ))}
          {hasMore ? (
            <button
              type="button"
              className="dashboard-kanban__more-btn dashboard-more-btn"
              onClick={onExpand}
            >
              More (+{ordered.length - limit})
            </button>
          ) : null}
        </div>
      </MotionConfig>
    </Tag>
  );
}
