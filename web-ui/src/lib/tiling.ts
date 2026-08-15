/**
 * n-ary split-tree tiling engine (i3-style), per the Workspaces PRD §3 /
 * tiling design research. Pure functions — every op returns a NEW root,
 * never mutates its input, so React state updates are trivial.
 *
 * Actively used by the real app — `WorkspaceCanvas.tsx` (tiling-mode canvas)
 * and `useStore.ts` (`insertTileIntoWorkspaceDoc`, Phase 4c auto-insert).
 * The original design was validated first as a standalone POC artifact
 * (`.scratch/workspaces-poc.html`, superseded/historical — see
 * .vibekit/feature-plans/wip/agent-interaction-workspaces/04-workspaces);
 * this file is the real, shipped implementation, not that POC.
 */

export type Axis = "row" | "column";

export interface SplitNode {
  id: string;
  type: "split";
  axis: Axis;
  children: LayoutNode[];
  /** Same length as children; sums to ~1 (normalized after every mutation). */
  sizes: number[];
}

export interface LeafNode {
  id: string;
  type: "leaf";
  tileId: string;
}

export type LayoutNode = SplitNode | LeafNode;

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

export type Side = "left" | "right" | "top" | "bottom";

function axisForSide(side: Side): Axis {
  return side === "left" || side === "right" ? "row" : "column";
}

function normalize(sizes: number[]): number[] {
  const sum = sizes.reduce((a, b) => a + b, 0);
  if (sum <= 0) return sizes.map(() => 1 / sizes.length);
  return sizes.map((s) => s / sum);
}

function findParent(
  root: LayoutNode,
  targetId: string,
): { parent: SplitNode; index: number } | null {
  if (root.type === "leaf") return null;
  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i];
    if (!child) continue;
    if (child.id === targetId) return { parent: root, index: i };
    const found = findParent(child, targetId);
    if (found) return found;
  }
  return null;
}

function findNode(root: LayoutNode | null, id: string): LayoutNode | null {
  if (!root) return null;
  if (root.id === id) return root;
  if (root.type === "leaf") return null;
  for (const child of root.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/** Deep clone — cheap enough for a POC's tree sizes, keeps ops pure/simple. */
function clone<T>(node: T): T {
  return JSON.parse(JSON.stringify(node));
}

/**
 * Insert a new leaf next to `targetLeafId`, on `side`. If the target's
 * parent already splits along the matching axis, the new leaf joins as a
 * sibling (halving the target's size). Otherwise the target leaf is
 * replaced in-place by a new 2-child split container.
 */
export function insertPane(
  root: LayoutNode | null,
  targetLeafId: string | null,
  side: Side,
  newTileId: string,
): LayoutNode {
  const newLeaf: LeafNode = { id: nextId("leaf"), type: "leaf", tileId: newTileId };
  if (!root || !targetLeafId) return newLeaf;

  const next = clone(root);
  const axis = axisForSide(side);
  const before = side === "left" || side === "top";

  const loc = findParent(next, targetLeafId);
  if (loc && loc.parent.axis === axis) {
    const insertAt = before ? loc.index : loc.index + 1;
    const half = (loc.parent.sizes[loc.index] ?? 1) / 2;
    loc.parent.sizes[loc.index] = half;
    loc.parent.sizes.splice(insertAt, 0, half);
    loc.parent.children.splice(insertAt, 0, newLeaf);
    return next;
  }

  // Replace the target leaf itself with a new split container.
  const target = findNode(next, targetLeafId);
  if (!target) return next; // target vanished — no-op, caller should re-render from fresh state
  const replacement: SplitNode = {
    id: nextId("split"),
    type: "split",
    axis,
    children: before ? [newLeaf, clone(target)] : [clone(target), newLeaf],
    sizes: [0.5, 0.5],
  };
  if (target.id === next.id) return replacement; // target was root
  const parentLoc = findParent(next, targetLeafId);
  if (parentLoc) parentLoc.parent.children[parentLoc.index] = replacement;
  return next;
}

/**
 * Remove a leaf; its size is redistributed to remaining siblings. A
 * single-child parent collapses into that child, merging same-axis nesting
 * so dividers never end up orphaned one level too deep.
 */
export function removePane(root: LayoutNode | null, leafId: string): LayoutNode | null {
  if (!root) return null;
  if (root.type === "leaf") return root.id === leafId ? null : root;

  const next = clone(root);
  const loc = findParent(next, leafId);
  if (!loc) return next; // not found — no-op

  loc.parent.children.splice(loc.index, 1);
  loc.parent.sizes.splice(loc.index, 1);
  loc.parent.sizes = normalize(loc.parent.sizes);

  return collapseSingleChildren(next);
}

/** Recursively collapse any split left with exactly one child, merging same-axis nesting. */
function collapseSingleChildren(node: LayoutNode): LayoutNode | null {
  if (node.type === "leaf") return node;

  node.children = node.children
    .map((c) => collapseSingleChildren(c))
    .filter((c): c is LayoutNode => c !== null);

  if (node.children.length === 0) return null;
  const only = node.children[0];
  if (node.children.length === 1 && only) return only;

  // Merge same-axis grandchildren up one level (avoids row>row nesting).
  const merged: LayoutNode[] = [];
  const mergedSizes: number[] = [];
  node.children.forEach((child, i) => {
    if (!child) return;
    if (child.type === "split" && child.axis === node.axis) {
      const scale = node.sizes[i] ?? 1;
      child.children.forEach((gc, j) => {
        if (!gc) return;
        merged.push(gc);
        mergedSizes.push((child.sizes[j] ?? 1) * scale);
      });
    } else {
      merged.push(child);
      mergedSizes.push(node.sizes[i] ?? 1);
    }
  });
  node.children = merged;
  node.sizes = normalize(mergedSizes);
  return node;
}

/**
 * Swap two tiles' positions in the tree by exchanging the `tileId` of their
 * leaves — the tree's SHAPE and every split size are untouched, so the two
 * panes simply trade rectangles. This is what a "drop on the center zone" does
 * (see WorkspaceCanvas's drag-to-tile); an edge-zone drop instead restructures
 * via removePane + insertPane. No-op if either tile isn't in the tree.
 */
export function swapPanes(
  root: LayoutNode | null,
  tileIdA: string,
  tileIdB: string,
): LayoutNode | null {
  if (!root || tileIdA === tileIdB) return root;
  const next = clone(root);
  let leafA: LeafNode | null = null;
  let leafB: LeafNode | null = null;
  const visit = (node: LayoutNode) => {
    if (node.type === "leaf") {
      if (node.tileId === tileIdA) leafA = node;
      else if (node.tileId === tileIdB) leafB = node;
      return;
    }
    node.children.forEach(visit);
  };
  visit(next);
  if (!leafA || !leafB) return next;
  (leafA as LeafNode).tileId = tileIdB;
  (leafB as LeafNode).tileId = tileIdA;
  return next;
}

/**
 * Zero-sum resize of two adjacent children in one split container, clamped
 * to a minimum. `deltaFraction` is the TOTAL delta since the drag started
 * (not since the last mousemove) — callers must compute it against a fixed
 * drag-start baseline, not against the live/already-mutated tree, or the
 * resize compounds every tick and the divider runs away under the cursor.
 * `baseSizes` — the [a, b] sizes at drag-start — makes that baseline
 * explicit and unambiguous rather than relying on caller discipline alone.
 */
export function resizeSplit(
  root: LayoutNode | null,
  splitId: string,
  dividerIndex: number,
  deltaFraction: number,
  baseSizes: [number, number],
  minFraction = 0.12,
): LayoutNode | null {
  if (!root) return null;
  const next = clone(root);
  const node = findNode(next, splitId);
  if (!node || node.type !== "split") return next;

  const a = dividerIndex;
  const b = dividerIndex + 1;
  if (a < 0 || b >= node.sizes.length) return next;

  let newA = baseSizes[0] + deltaFraction;
  let newB = baseSizes[1] - deltaFraction;
  if (newA < minFraction) {
    const diff = minFraction - newA;
    newA = minFraction;
    newB -= diff;
  }
  if (newB < minFraction) {
    const diff = minFraction - newB;
    newB = minFraction;
    newA -= diff;
  }
  node.sizes[a] = newA;
  node.sizes[b] = newB;
  return next;
}

/**
 * Deterministic free-form → tiled conversion: sort tiles in reading order
 * (top-to-bottom band, then left-to-right), then recursively bisect —
 * NOT a geometry-faithful reconstruction (free-form tiles can overlap, so
 * none exists), but order-preserving and simple. Axis alternates per depth.
 */
export function buildBalancedTree(
  tileIdsInReadingOrder: string[],
  axis: Axis = "row",
): LayoutNode | null {
  if (tileIdsInReadingOrder.length === 0) return null;
  if (tileIdsInReadingOrder.length === 1) {
    return { id: nextId("leaf"), type: "leaf", tileId: tileIdsInReadingOrder[0]! };
  }
  const mid = Math.ceil(tileIdsInReadingOrder.length / 2);
  const left = tileIdsInReadingOrder.slice(0, mid);
  const right = tileIdsInReadingOrder.slice(mid);
  const nextAxis: Axis = axis === "row" ? "column" : "row";
  return {
    id: nextId("split"),
    type: "split",
    axis,
    children: [buildBalancedTree(left, nextAxis)!, buildBalancedTree(right, nextAxis)!],
    sizes: [left.length / tileIdsInReadingOrder.length, right.length / tileIdsInReadingOrder.length],
  };
}

/** Collect leaf tileIds in tree order (used to render + to seed the reverse conversion). */
export function collectTileIds(root: LayoutNode | null): string[] {
  if (!root) return [];
  if (root.type === "leaf") return [root.tileId];
  return root.children.flatMap(collectTileIds);
}

/** Find the leaf NODE's own id (not the tile id) hosting `tileId`, or null. */
export function findLeafId(root: LayoutNode | null, tileId: string): string | null {
  if (!root) return null;
  if (root.type === "leaf") return root.tileId === tileId ? root.id : null;
  for (const child of root.children) {
    const found = findLeafId(child, tileId);
    if (found) return found;
  }
  return null;
}
