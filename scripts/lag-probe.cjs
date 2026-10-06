// TEMPORARY (#390 debug run): event-loop lag sampler, preloaded via NODE_OPTIONS.
const fs = require("node:fs");
const { isMainThread, threadId } = require("node:worker_threads");
const who = isMainThread ? `main/pid${process.pid}` : `worker${threadId}/pid${process.pid}`;
const out = (s) => { try { fs.writeSync(2, `${s}\n`); } catch {} };
const perFile = new Map();
let last = Date.now();
let winMax = 0;
let winStart = last;
const t = setInterval(() => {
  const now = Date.now();
  const drift = now - last - 100;
  last = now;
  const w = globalThis.__vitest_worker__;
  const file = w && w.filepath ? w.filepath.replace(/^.*\/mxlang\/mxlang\//, "") : "-";
  if (drift > (perFile.get(file) || 0)) perFile.set(file, drift);
  const cur = w && w.current;
  const phase = cur ? `test=${String(cur.name || (cur.suite && cur.suite.name) || "?").slice(0, 80)}` : "phase=collect-or-idle";
  if (drift > 1000) out(`[lag] ${who} file=${file} blockMs=${drift} ${phase} at=${new Date(now).toISOString()}`);
  if (drift > winMax) winMax = drift;
  if (isMainThread && now - winStart >= 10000) {
    out(`[lag-main] pid=${process.pid} window10s maxLagMs=${winMax} at=${new Date(now).toISOString()}`);
    winMax = 0; winStart = now;
  }
}, 100);
t.unref();
process.on("exit", () => {
  const top = [...perFile].sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [f, ms] of top) if (ms > 500) out(`[lag-top] ${who} file=${f} maxBlockMs=${ms}`);
});
