// compare-frames.mjs <dirA> <dirB> [--strict]
// Compares every *.frames.jsonl (ordered ACP frames), *.argv.json (what the adapter
// passed to `claude`: argv + env allow-list) and *.init.json / initialize.json.
// Non --strict mode applies the port's accepted-difference list
// (rust/claude-agent-acp-rs/tests/differential.rs `base_ignore` + the
// tool_call default-materialisation + agentInfo version normalisers).
// Prints one line per script and, for each difference, `path: A -> B`.
// Exit 1 if any non-ignored difference remains.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const [dirA, dirB] = args.filter((a) => !a.startsWith("--"));

const IGNORE = [
  /^frame\.result\.(modes|configOptions|models|authMethods)(\.|$)/,
  /usage_update/,
  /^frame\.result\.agentInfo\.(name|version)$/,
];

function norm(o) {
  // tool_call: Node always emits status:"pending" and content:[]; the Rust crate omits
  // defaults on the wire. Materialise on both sides (same as the port's normalizer).
  const w = (v) => {
    if (Array.isArray(v)) return v.map(w);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = w(x);
      if (out.sessionUpdate === "tool_call") {
        if (out.status === undefined) out.status = "pending";
        if (out.content === undefined) out.content = [];
      }
      return out;
    }
    return v;
  };
  return w(o);
}

function diff(a, b, p, out) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    out.push([p, a, b]);
    return;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], p ? `${p}.${k}` : k, out);
}
const trunc = (v) => { const s = JSON.stringify(v) ?? "undefined"; return s.length > 200 ? s.slice(0, 200) + "…" : s; };
const ignored = (p, frameJson) => !strict && (IGNORE.some((r) => r.test(p)) || IGNORE[1].test(frameJson));

const names = new Set([...fs.readdirSync(dirA), ...fs.readdirSync(dirB)].filter((n) => /\.(frames\.jsonl|argv\.json|init\.json)$|^initialize\.json$/.test(n)));
let bad = 0, files = 0, identical = 0;
for (const n of [...names].sort()) {
  const fa = path.join(dirA, n), fb = path.join(dirB, n);
  if (!fs.existsSync(fa) || !fs.existsSync(fb)) { console.log(`MISSING ${n} (${fs.existsSync(fa) ? "B" : "A"} lacks it)`); bad++; continue; }
  files++;
  let diffs = [];
  if (n.endsWith(".jsonl")) {
    const rd = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    let A = rd(fa), B = rd(fb);
    if (!strict) { A = A.map(norm); B = B.map(norm); }
    if (A.length !== B.length) diffs.push([`(frame count)`, A.length, B.length]);
    for (let i = 0; i < Math.min(A.length, B.length); i++) {
      const d = []; diff(A[i], B[i], "", d);
      const fj = JSON.stringify(A[i]) + JSON.stringify(B[i]);
      for (const [p, x, y] of d) if (!ignored(p, fj)) diffs.push([`[${i}] ${p}`, x, y]);
    }
  } else {
    const d = []; diff(JSON.parse(fs.readFileSync(fa, "utf8")), JSON.parse(fs.readFileSync(fb, "utf8")), "", d);
    diffs = d;
  }
  if (diffs.length === 0) identical++;
  else { bad++; console.log(`DIFF ${n}`); for (const [p, x, y] of diffs.slice(0, 20)) console.log(`   ${p}: ${trunc(x)} -> ${trunc(y)}`); if (diffs.length > 20) console.log(`   … ${diffs.length - 20} more`); }
}
console.log(`${files} files compared, ${identical} identical${strict ? "" : " (after ignores)"}, ${bad} with differences`);
process.exit(bad ? 1 : 0);
