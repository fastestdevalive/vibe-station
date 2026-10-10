/** Human-readable text for a rejected API call. The daemon replies with
 *  `{ "error": "…" }`; `ApiError.message` carries that raw body, so unwrap it. */
export function apiErrorText(e: unknown, fallback = "Something went wrong"): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") {
      return (parsed as { error: string }).error;
    }
  } catch {
    // not JSON — fall through to the raw text
  }
  return raw || fallback;
}
