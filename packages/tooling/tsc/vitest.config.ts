import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mxlang/tsc",
    // Nearly every test here shells out to `mx-tsc` through spawnSync (10-85 s
    // each under load). A synchronous call blocks its host event loop, and in
    // a `threads` worker that is the loop carrying vitest's RPC channel, so
    // birpc's fixed 60 s timeout fires ("Timeout calling onTaskUpdate") even
    // though every test passes. `forks` gives each file its own child process,
    // so a long synchronous test starves only that process.
    pool: "forks",
  },
});
