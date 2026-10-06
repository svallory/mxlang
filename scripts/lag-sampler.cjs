// Preloaded into vitest's processes by CI (NODE_OPTIONS=--require). Samples
// event-loop drift every 100 ms and appends each block over 500 ms to the file
// named by MX_LAG_LOG as one JSON line, tagged with the running test file;
// scripts/lag-top.cjs prints the longest. Observation only: nothing here fails
// a run. Inside a vitest worker it removes itself from NODE_OPTIONS (the worker
// itself is already running it), so child processes the tests spawn (mx-tsc in
// temp dirs, where a preload would resolve against a malformed package.json)
// do not preload it.
const fs = require("node:fs");

const log = process.env.MX_LAG_LOG;
const strip = () => {
  if (process.env.NODE_OPTIONS) {
    process.env.NODE_OPTIONS = process.env.NODE_OPTIONS.replace(
      /--require\s+\S*lag-sampler\.cjs/,
      "",
    ).trim();
  }
};
if (log) {
  const root = process.env.GITHUB_WORKSPACE || process.cwd();
  let last = Date.now();
  let stripped = false;
  const timer = setInterval(() => {
    const now = Date.now();
    const blockMs = now - last - 100;
    last = now;
    const worker = globalThis.__vitest_worker__;
    if (worker && !stripped) {
      stripped = true;
      strip();
    }
    if (blockMs < 500) return;
    const file = worker?.filepath
      ? worker.filepath.replace(`${root}/`, "")
      : "-";
    const test = worker?.current?.name ?? "";
    try {
      fs.appendFileSync(
        log,
        `${JSON.stringify({ blockMs, file, test: String(test).slice(0, 100), pid: process.pid })}\n`,
      );
    } catch {}
  }, 100);
  timer.unref();
}
