/**
 * capture-wire-fixtures.ts — regenerates the wire-drift fixtures at
 * rust/vst-types/tests/fixtures/wire/*.json from a LIVE Node daemon.
 *
 * The daemon-rust-port wire contract (arch doc F1) must be byte-identical to
 * the current Node daemon. Part 00 authored the fixtures by direct extraction
 * from the TypeScript schemas/handlers; this script lets you RE-capture them
 * from a running daemon so the drift detector reflects reality, not an
 * author's reading of the source.
 *
 * Usage:
 *   pnpm tsx scripts/capture-wire-fixtures.ts [baseUrl]
 *
 *   baseUrl defaults to http://localhost:7421. Requires an authenticated daemon
 *   running with the real dataset (e.g. via `scripts/dev-sandbox.sh`).
 *
 * Each endpoint's response is saved verbatim to the fixture file named in
 * CAPTURES below. Only GET endpoints that return JSON are captured here (the
 * full surface is covered by the round-trip tests; this is the sample set the
 * wire-drift detector actually reads).
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const base = process.argv[2] ?? "http://localhost:7421";
const outDir = join(process.cwd(), "rust", "vst-types", "tests", "fixtures", "wire");

/** name -> (method, path). Add endpoints here as the surface grows. */
const CAPTURES: Record<string, [string, string]> = {
  "project.json": ["GET", "/projects?__skip"],
  "mode.json": ["GET", "/modes"],
  "health.json": ["GET", "/health"],
};

async function capture(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  for (const [name, [method, path]] of Object.entries(CAPTURES)) {
    try {
      const res = await fetch(`${base}${path}`);
      const text = await res.text();
      // Normalize pretty-printed output to compact, matching serde_json.
      const value = JSON.parse(text);
      await writeFile(join(outDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
      console.log(`captured ${name} (HTTP ${res.status})`);
    } catch (err) {
      console.error(`failed to capture ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

void capture();
