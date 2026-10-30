// live-brief.mjs <dir> [<dir>...] — one compact block per scenario per adapter, for human review.
import fs from "node:fs";
import path from "node:path";
const dirs = process.argv.slice(2);
const sums = dirs.map((d) => JSON.parse(fs.readFileSync(path.join(d, "summary.json"), "utf8")));
const names = Object.keys(sums[0].scenarios);
const brief = (e) => {
  if (!e) return "(missing)";
  const kinds = (e.updateShape || []).filter((s) => s.k !== "available_commands_update").map((s) => s.k + (s.kind ? `:${s.kind}` : "") + (s.status ? `[${s.status}]` : "") + (s.repeat ? "*" : ""));
  return JSON.stringify({
    err: e.error, stop: e.result?.stopReason ?? e.result?.error ?? (e.result?.first ? [e.result.first.stopReason, e.result.second?.stopReason] : undefined),
    kinds, text: e.agentText?.slice(0, 120), perms: e.permissions?.map((p) => p.options.map((o) => `${o.kind}`).join("/")),
    fs: e.fsCalls?.map((f) => f.m), terminals: e.terminals, file: e.fileAfter, cancelMs: e.cancelLatencyMs,
    extra: e.extra && Object.fromEntries(Object.entries(e.extra).filter(([k]) => !["sessionLoadResponse"].includes(k))),
  });
};
for (const n of names) {
  console.log(`\n### ${n}`);
  sums.forEach((s) => console.log(`- ${s.label}: ${brief(s.scenarios[n])}`));
}
