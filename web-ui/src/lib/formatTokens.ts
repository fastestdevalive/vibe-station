/** Compact token count: exact below 1000, then 1.3k / 22.8k / 999.9k / 1M. */
export function fmt(n: number): string {
  const trim = (x: number) => x.toFixed(1).replace(/\.0$/, "");
  if (n < 1000) return String(n);
  const k = Math.round(n / 100) / 10;
  if (k < 1000) return `${trim(k)}k`;
  return `${trim(Math.round(n / 100000) / 10)}M`;
}
