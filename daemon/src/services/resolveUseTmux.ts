// @ts-nocheck
/**
 * Coerce undefined/absent useTmux values to true for back-compat.
 *
 * Called at manifest read time (loadAll) and at HTTP route handlers,
 * ensuring every in-memory SessionRecord.useTmux is a concrete boolean
 * before it reaches spawn/lifecycle/recover code.
 */

export function resolveUseTmux(input?: boolean): boolean {
  return input ?? true;
}
