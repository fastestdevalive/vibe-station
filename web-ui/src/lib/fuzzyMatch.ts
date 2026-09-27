/**
 * Case-insensitive subsequence match with a simple contiguity bonus —
 * good enough for sidebar-sized lists (tens to low hundreds of rows),
 * framework-free so it can be reused outside React later.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      score += 1 + streak;
      streak++;
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : null; // null = no match
}
