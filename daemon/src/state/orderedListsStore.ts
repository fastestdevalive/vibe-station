/**
 * Read/write access to the `user_ordered_lists` table (pinned-order-sync).
 * Every query is scoped to the single implicit `'local'` user — see
 * `routes/orderedLists.ts` for the allowlist of valid `scopeKey`s and the
 * future-user-model rationale.
 */
import { getDb } from "./db.js";

const LOCAL_USER_ID = "local";

export interface OrderedList {
  itemIds: string[];
  updatedAt: string | null;
}

export function getOrderedList(scopeKey: string): OrderedList {
  const row = getDb()
    .prepare("SELECT itemIds, updatedAt FROM user_ordered_lists WHERE userId = ? AND scopeKey = ?")
    .get(LOCAL_USER_ID, scopeKey) as { itemIds: string; updatedAt: string } | undefined;
  if (!row) return { itemIds: [], updatedAt: null };
  return { itemIds: JSON.parse(row.itemIds) as string[], updatedAt: row.updatedAt };
}

export function setOrderedList(scopeKey: string, itemIds: string[]): OrderedList {
  const updatedAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO user_ordered_lists (userId, scopeKey, itemIds, updatedAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(userId, scopeKey) DO UPDATE SET itemIds = excluded.itemIds, updatedAt = excluded.updatedAt`,
    )
    .run(LOCAL_USER_ID, scopeKey, JSON.stringify(itemIds), updatedAt);
  return { itemIds, updatedAt };
}
