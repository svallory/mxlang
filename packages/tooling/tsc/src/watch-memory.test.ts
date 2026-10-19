import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { watchInMemory } from "./watch-memory.ts";

/** Every environment name `watchInMemory` touches. */
const NAMES = [
  "NO_COLOR",
  "FORCE_COLOR",
  "TSC_WATCHFILE",
  "TSC_WATCHDIRECTORY",
  "TSC_WATCH_POLLINGCHUNKSIZE_LOW",
  "TSC_WATCH_POLLINGCHUNKSIZE_MEDIUM",
  "TSC_WATCH_POLLINGCHUNKSIZE_HIGH",
  "TSC_WATCH_POLLINGINTERVAL_LOW",
  "TSC_WATCH_POLLINGINTERVAL_MEDIUM",
  "TSC_WATCH_POLLINGINTERVAL_HIGH",
] as const;

/**
 * `stop()` must leave a variable unset that was unset before the watcher
 * started: assigning `undefined` back stores the *string* `"undefined"`,
 * which counts as set — a set `NO_COLOR` turns colour off and a set
 * `FORCE_COLOR` forces pretty output for every later run in this worker.
 */
describe("watchInMemory", () => {
  it("stop() leaves environment variables unset that were unset before the watcher started", () => {
    const before = { ...process.env };
    for (const name of NAMES) delete process.env[name];
    const dir = mkdtempSync(join(tmpdir(), "mx-tsc-watch-memory-"));
    try {
      // A clock that never runs a timer is enough: only start/stop are used.
      const watcher = watchInMemory(dir, ["-w", "-p", "tsconfig.json"], {
        advance: () => Promise.resolve(),
        clear: () => {},
      });
      expect(process.env.NO_COLOR).toBe("1");
      expect(process.env.TSC_WATCHFILE).toBe("DynamicPriorityPolling");
      watcher.stop();
      for (const name of NAMES) {
        expect(name in process.env, `${name} should be unset`).toBe(false);
        expect(process.env[name]).toBeUndefined();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      for (const name of NAMES) {
        if (before[name] !== undefined) process.env[name] = before[name];
      }
    }
  });
});
