// Prints the five longest single synchronous blocks recorded by
// scripts/lag-sampler.cjs. No failing threshold.
const fs = require("node:fs");

const log = process.argv[2] || process.env.MX_LAG_LOG;
let lines = [];
try {
  lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
} catch {}
const top = lines
  .map((line) => JSON.parse(line))
  .sort((a, b) => b.blockMs - a.blockMs)
  .slice(0, 5);
console.log("longest synchronous blocks (event-loop lag, ms):");
if (top.length === 0) console.log("  none over 500 ms");
for (const b of top) console.log(`  ${b.blockMs}  ${b.file}  ${b.test}`);
