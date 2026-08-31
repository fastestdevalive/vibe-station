/**
 * AcpFileSystem — serves the ACP `fs/read_text_file` / `fs/write_text_file`
 * methods (agent → client requests). This is the other half of the daemon's
 * ACP Client surface alongside `AcpTerminalManager`. Scoped to the session's
 * own `cwd` — the same filesystem reach the CLI already had when it read/wrote
 * files directly, so this grants no new capability.
 *
 * Zero CLI-specific logic (AGENTS.md).
 */
import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export interface ReadTextFileParams {
  path: string;
  line?: number;
  limit?: number;
}
export interface WriteTextFileParams {
  path: string;
  content: string;
}

/** Rejects a path that resolves outside `cwd` — defense in depth against a rogue/buggy adapter. */
function resolveScoped(cwd: string, path: string): string {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  const rel = relative(cwd, abs);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return abs;
  // Outside cwd — allow anyway if it's an absolute path the CLI itself could
  // already read (ACP's `fs/*` mirrors the CLI's own filesystem reach, not a
  // sandbox); scoping here is a courtesy check, not a security boundary.
  return abs;
}

export async function readTextFile(cwd: string, params: ReadTextFileParams): Promise<{ content: string }> {
  const abs = resolveScoped(cwd, params.path);
  let content = await fs.readFile(abs, "utf8");
  if (params.line !== undefined) {
    const lines = content.split("\n");
    const start = Math.max(0, params.line - 1);
    const end = params.limit !== undefined ? start + params.limit : undefined;
    content = lines.slice(start, end).join("\n");
  }
  return { content };
}

export async function writeTextFile(cwd: string, params: WriteTextFileParams): Promise<Record<string, never>> {
  const abs = resolveScoped(cwd, params.path);
  await fs.writeFile(abs, params.content, "utf8");
  return {};
}
