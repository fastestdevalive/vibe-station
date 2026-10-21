import type { ReactNode } from "react";
import { useHoverFrozenOrder } from "@/hooks/useHoverFrozenOrder";

interface DashboardCardGroupProps<T> {
  /** Already sorted (newest activity first) by the caller. */
  items: T[];
  idOf: (item: T) => string;
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
 * card out from under the cursor; it re-sorts on pointer leave.
 */
export function DashboardCardGroup<T>({
  items,
  idOf,
  renderItem,
  limit = 10,
  expanded,
  onExpand,
  as: Tag = "div",
  className,
  header,
}: DashboardCardGroupProps<T>) {
  const ids = items.map(idOf);
  const { order, hoverProps } = useHoverFrozenOrder(ids);
  const byId = new Map(items.map((item) => [idOf(item), item]));
  const ordered = order.map((id) => byId.get(id)).filter((x): x is T => x !== undefined);
  const visible = expanded ? ordered : ordered.slice(0, limit);
  const hasMore = ordered.length > limit && !expanded;

  return (
    <Tag className={className} {...hoverProps}>
      {header}
      <div className="dashboard-card-list">
        {visible.map(renderItem)}
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
    </Tag>
  );
}
