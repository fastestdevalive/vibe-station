#!/usr/bin/env node
import { buildProgram } from "./program.js";

const program = buildProgram();
program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`vst: ${message}\n`);
  process.exit(1);
});
