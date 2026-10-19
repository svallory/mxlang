import { chdir, cwd } from "node:process";
import { runMxTscArgs } from "./index.ts";

/**
 * `mx-tsc -w` run in this process, its rebuilds driven by virtual time.
 *
 * The watch loop is TypeScript's own: with `TSC_WATCHFILE`/
 * `TSC_WATCHDIRECTORY` set to the `DynamicPriorityPolling` strategies there
 * are no real file watchers at all — every watch is a `getModifiedTime` poll
 * scheduled on a `setTimeout` — so with fake timers installed
 * (`vi.useFakeTimers`) a whole write → poll → rebuild → summary round trip
 * runs inside `advanceTimersByTime`, deterministically, in milliseconds
 * of wall time. No child process, no sleeps, no output polling: a cycle is
 * over when its summary is written, which the harness sees the moment tsc
 * writes it.
 *
 * The watcher changes this process's working directory (tsc prints paths, and
 * resolves project arguments, relative to it), captures `process.stdout` and
 * `process.stderr`, and sets the polling-strategy environment variables;
 * `stop()` puts all of it back and clears every pending timer, so runs never
 * interfere. Runs are synchronous and process-global: one at a time.
 */
export const SUMMARY_ENGLISH =
  /Found \d+ errors?\. Watching for file changes\./;

/** Advances the process's (fake) clock and lets its timers run. */
export interface VirtualClock {
  advance: (ms: number) => Promise<unknown>;
  /** Drops every pending timer (the watcher's own polls included). */
  clear: () => void;
}

export interface MemoryWatch {
  /** The first build, run synchronously; its output, summary included. */
  start: () => string;
  /**
   * Runs `act` (the change a rebuild is provoked with), advances virtual time
   * until that rebuild's summary is written, and returns the cycle's whole
   * text. Throws when no matching summary lands within the virtual budget —
   * deterministically, with everything the watcher printed.
   */
  cycle: (act?: () => void) => Promise<string>;
  /** Everything the watcher printed so far (stdout and stderr, in order). */
  output: () => string;
  /** Restores the process: timers cleared, streams, cwd and env back. */
  stop: () => void;
}

/** The virtual time one `cycle` may spend before giving up: 120 s. */
const VIRTUAL_BUDGET_MS = 120_000;
/** One step of virtual time; a poll, a debounce or a build turn fits in it. */
const STEP_MS = 250;

export function watchInMemory(
  dir: string,
  args: readonly string[],
  clock: VirtualClock,
  isSummary: (text: string) => boolean = (text) => SUMMARY_ENGLISH.test(text),
): MemoryWatch {
  const previousCwd = cwd();
  const writeOut = process.stdout.write;
  const writeErr = process.stderr.write;
  const exitCode = process.exitCode;
  const env = { ...process.env } as Record<string, string | undefined>;
  let buffer = "";
  process.chdir(dir);
  process.stdout.write = ((chunk: unknown) => {
    buffer += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    buffer += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.env.NO_COLOR = "1";
  process.env.TSC_WATCHFILE = "DynamicPriorityPolling";
  process.env.TSC_WATCHDIRECTORY =
    "RecursiveDirectoryUsingDynamicPriorityPolling";
  // Poll every watched file on every round (the default chunks a few files
  // per round, so noticing a change takes a whole sweep of virtual time), and
  // poll rarely (virtual time is free: fewer rounds means fewer stat sweeps
  // of wall time per cycle, while a change still lands within the budget).
  for (const level of ["LOW", "MEDIUM", "HIGH"]) {
    process.env[`TSC_WATCH_POLLINGCHUNKSIZE_${level}`] = "1000000";
  }
  process.env.TSC_WATCH_POLLINGINTERVAL_LOW = "2000";
  process.env.TSC_WATCH_POLLINGINTERVAL_MEDIUM = "4000";
  process.env.TSC_WATCH_POLLINGINTERVAL_HIGH = "8000";
  delete process.env.FORCE_COLOR;

  const cycleFrom = async (since: number): Promise<string> => {
    for (let spent = 0; spent < VIRTUAL_BUDGET_MS; spent += STEP_MS) {
      await clock.advance(STEP_MS);
      const text = buffer.slice(since);
      // The caller's matcher decides a cycle is complete; the summary is its
      // last line, so nothing more of that cycle is coming.
      if (isSummary(text)) {
        return text;
      }
    }
    throw new Error(
      `watch did not finish a rebuild within ${VIRTUAL_BUDGET_MS} ms of virtual time:\n${buffer.slice(since) || "(nothing printed)"}`,
    );
  };

  const watch: MemoryWatch = {
    start: () => {
      runMxTscArgs([...args, "--pretty", "false", "--preserveWatchOutput"]);
      const text = buffer;
      if (!isSummary(text)) {
        throw new Error(
          `the first build printed no recognized summary:\n${text || "(nothing printed)"}`,
        );
      }
      return text;
    },
    cycle: async (act) => {
      const since = buffer.length;
      act?.();
      return cycleFrom(since);
    },
    output: () => buffer,
    stop: () => {
      // Run out the pending immediates and short timers (a missed-rebuild
      // decision in flight) *before* dropping every timer: a decision cleared
      // mid-flight would leave the watch machinery marked busy for the next
      // watcher. Their writes land in this watcher's captured, discarded
      // buffer.
      for (let step = 0; step < 4; step++) void clock.advance(250);
      clock.clear();
      process.stdout.write = writeOut;
      process.stderr.write = writeErr;
      process.exitCode = exitCode;
      // Restore each name with a delete when it was unset before: a plain
      // `process.env.X = env.X` would store the *string* "undefined" when X
      // did not exist, and a set NO_COLOR/FORCE_COLOR/TSC_WATCH* would then
      // change every later run in this worker (colour off, pretty forced,
      // the polling strategies named but bogus).
      for (const name of [
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
      ] as const) {
        if (env[name] === undefined) delete process.env[name];
        else process.env[name] = env[name];
      }
      chdir(previousCwd);
    },
  };
  return watch;
}
