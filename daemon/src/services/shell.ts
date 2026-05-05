// @ts-nocheck
/**
 * Shell-quoting utility. No external dependencies.
 */

/**
 * Single-quote-wrap a string, escaping any embedded single quotes. POSIX-safe for sh/bash.
 * Use this for all user-controlled or path values inserted into shell command strings.
 */
export function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
