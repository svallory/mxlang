import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runInProcess } from "./in-process.ts";

/**
 * Each of these tests spawns a real `tsc`, which takes ~1s alone but well past
 * vitest's 5s default when the whole root suite runs in parallel on a loaded
 * machine. The budget is generous on purpose: a slow machine is not a
 * regression, and a flaky gate is worse than a slow one.
 */
export const SPAWN_TIMEOUT_MS = 60_000;

export const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "..", "..", "..", "..");
export const fixtures = join(here, "fixtures");
export const astroStatic = join(repoRoot, "examples", "astro-static");
export const preactApp = join(repoRoot, "examples", "preact-app");
export const reactApp = join(repoRoot, "examples", "react-app");
export const honoApp = join(repoRoot, "examples", "hono-app");

/**
 * `mx-tsc` is a real `tsc` with Volar's program proxy spliced in, so there is
 * no in-process surface to assert against: the thing under test *is* the
 * process's diagnostics and exit code. These tests therefore run the built
 * entry point, which means `bun run build` must have produced `dist/bin.cjs`
 * first — the same fresh-worktree caveat `@mxlang/tsx-bridge`'s `dist/index.js`
 * carries.
 *
 * `dist/bin.cjs` directly, not `node_modules/.bin/mx-tsc`: bun creates a bin
 * symlink at *install* time and silently skips one whose target does not exist
 * yet. In CI `bun install` always runs before `bun run build`, so that symlink
 * is never created there — which is exactly how this was found (`mx-tsc:
 * command not found`, on a machine where the local link existed from an
 * earlier build). Running the file needs no linking at all.
 *
 * `mxTsc` is spawned, not run in this process; `src/index.ts` evaluates the
 * transformed `tsc.js` itself, so it no longer depends on the loader route
 * Node's `require` takes: the spawned runtimes (node in the other suites,
 * `bun` in `bun-runtime.test.ts`) prove the built bin on both.
 */
export const mxTsc = join(
  repoRoot,
  "packages",
  "tooling",
  "tsc",
  "dist",
  "bin.cjs",
);
export const plainTsc = join(
  repoRoot,
  "node_modules",
  "typescript",
  "bin",
  "tsc",
);

/**
 * `mx-angular build`, the second CLI surface the Angular fix hints must
 * behave on: same authored error, one error, no NG cascade. Run through its
 * built entry point with `--project` for the same fresh-`dist` reason as
 * `mxTsc` above.
 */
export const mxAngular = join(
  repoRoot,
  "packages",
  "hosts",
  "angular",
  "dist",
  "bin.js",
);

export interface Run {
  status: number;
  output: string;
}

export function run(entry: string, args: string[]): Run {
  // `mx-tsc` itself runs in this process (no child competing for the CPU, no
  // worker blocked in a synchronous spawn); other entries (plain `tsc`, for
  // contrast) are spawned.
  if (entry === mxTsc) {
    const { status, stdout, stderr } = runInProcess(args, here);
    return { status, output: `${stdout}${stderr}` };
  }
  try {
    const output = execFileSync(process.execPath, [entry, ...args], {
      cwd: here,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (cause) {
    const error = cause as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: error.status ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

/**
 * Spawn a CLI without blocking the worker. Like the spawned leg of `run`,
 * inherit the environment, use `here` as cwd, and leave the child timeout
 * unset. Successful runs return stdout only; failed runs include stderr.
 * Keep `mx-tsc` calls on synchronous `run`: its in-process capture is global.
 * Pass the test's `signal` (required) so a timed-out or aborted test kills the
 * child instead of leaving it running; an aborted run resolves with status 1.
 * stdin is closed, as in `run`, so a CLI that reads it cannot hang.
 */
export function runAsync(
  entry: string,
  args: string[],
  signal: AbortSignal,
): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [entry, ...args],
      { cwd: here, encoding: "utf8", signal },
      (error, stdout, stderr) => {
        resolve({
          status: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          output: error ? `${stdout}${stderr}` : stdout,
        });
      },
    );
    child.stdin?.end();
  });
}

export interface RunSplit {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * `mx-tsc` writes its stored-diagnostic report to stderr (`src/index.ts`'s
 * `process.stderr.write`), independent of exit code. `execFileSync`'s return
 * value only ever carries stdout on a zero exit, so a warning-only run (exit
 * 0, diagnostics on stderr) is invisible to `run()` above — `spawnSync`
 * captures both streams regardless of exit code.
 */
export function runSplit(entry: string, args: string[]): RunSplit {
  if (entry === mxTsc) return runInProcess(args, here);
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: here,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Gap between touches while arming; see `spawnWatch`. */
const ARM_TOUCH_EVERY_MS = 2_500;
/** How long a watcher gets to print its first summary. */
export const WATCH_FIRST_SUMMARY_MS = 60_000;
/** How long tsc gets to arm its watchers after the first summary (~58 s under load). */
export const WATCH_ARM_MS = 150_000;

export interface SpawnedWatch {
  /** Everything the watcher printed so far (stdout and stderr). */
  output(): string;
  /** Resolves once `output.slice(since)` matches; rejects with the output on timeout or exit. */
  until(pattern: RegExp, since?: number, timeoutMs?: number): Promise<string>;
  /** Throws, with the output, if the watcher exited or failed to spawn. */
  assertAlive(doing: string): void;
  /** Kills the watcher and waits for it to close. Idempotent. */
  stop(): Promise<void>;
}

export interface SpawnWatchOptions {
  cwd: string;
  /** Arguments after the entry point, e.g. `["-w", "-p", "tsconfig.json"]`. */
  args: string[];
  entry?: string;
  /**
   * A file of the watched project. Required whenever the test acts on the
   * project after this returns: tsc registers its directory and file watchers
   * only after the first summary (plain TypeScript does the same; `-b -w`
   * walks every directory first, slow under load), so a change made right
   * after the summary can land before the watchers take their baseline and is
   * never reported. The helper appends a newline to this file until tsc
   * reports a rebuild, the one observable "armed" signal, then waits for the
   * rebuilds the touches caused to finish so none is mistaken for the test's
   * own. tsc creates all its watchers in one pass after the first summary,
   * so arming one file arms the rest. The output of the first build is
   * `output()` up to its first `Watching for file changes.`. Omit it for a
   * test that only reads the first build.
   */
  armFile?: string;
  /** Kill the watcher after this long even if the test never stops it. */
  lifetimeMs?: number;
}

/**
 * The one way watch tests spawn `tsc -w` / `-b -w`: polling watchers for steady
 * timing, NO_COLOR, output capture. Resolves with the first summary printed
 * and, when `armFile` is given, only once the watchers are armed. The caller
 * owns `stop()` (call it in a `finally`/`afterEach`).
 */
export async function spawnWatch(
  options: SpawnWatchOptions,
): Promise<SpawnedWatch> {
  const { cwd, args, entry = mxTsc, armFile, lifetimeMs } = options;
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      TSC_WATCHFILE: "DynamicPriorityPolling",
      TSC_WATCHDIRECTORY: "RecursiveDirectoryUsingDynamicPriorityPolling",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lifetime =
    lifetimeMs === undefined
      ? undefined
      : setTimeout(() => child.kill("SIGKILL"), lifetimeMs);
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      if (lifetime) clearTimeout(lifetime);
      resolve();
    }),
  );
  let output = "";
  let failure: Error | undefined;
  child.on("error", (error) => {
    failure = error;
  });
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  const watch: SpawnedWatch = {
    output: () => output,
    assertAlive(doing) {
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`watch exited while ${doing}:\n${output}`);
      }
    },
    async until(pattern, since = 0, timeoutMs = WATCH_FIRST_SUMMARY_MS) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pattern.test(output.slice(since))) return output;
        watch.assertAlive(`waiting for ${pattern}`);
        await delay(100);
      }
      throw new Error(`timed out waiting for ${pattern}:\n${output}`);
    },
    async stop() {
      if (lifetime) clearTimeout(lifetime);
      child.kill("SIGKILL");
      await closed;
    },
  };
  try {
    await watch.until(/Found \d+ errors?/);
    if (armFile) await armWatch(watch, armFile);
  } catch (error) {
    await watch.stop();
    throw error;
  }
  return watch;
}

async function armWatch(watch: SpawnedWatch, file: string): Promise<void> {
  const since = watch.output().length;
  const deadline = Date.now() + WATCH_ARM_MS;
  let nextTouch = 0;
  let lastTouch = 0;
  while (!/File change detected/.test(watch.output().slice(since))) {
    watch.assertAlive("arming");
    if (Date.now() > deadline) {
      throw new Error(`watch never armed:\n${watch.output()}`);
    }
    if (Date.now() >= nextTouch) {
      appendFileSync(file, "\n");
      lastTouch = Date.now();
      nextTouch = lastTouch + ARM_TOUCH_EVERY_MS;
    }
    await delay(50);
  }
  // Return only when the rebuilds the touches caused are over: the last one
  // finished (a summary closes the output) and nothing new has appeared for
  // longer than the polling lag (`ARM_TOUCH_EVERY_MS`) after the last touch
  // and after the last output, so no trailing touch can rebuild after return.
  let seen = watch.output();
  let lastChange = Date.now();
  for (;;) {
    watch.assertAlive("arming");
    if (Date.now() > deadline) {
      throw new Error(`rebuild never settled:\n${watch.output()}`);
    }
    await delay(100);
    const output = watch.output();
    if (output !== seen) {
      seen = output;
      lastChange = Date.now();
      continue;
    }
    const quiet = Date.now() - Math.max(lastChange, lastTouch);
    const tail = output.slice(output.lastIndexOf("File change detected"));
    if (quiet >= ARM_TOUCH_EVERY_MS && /Found \d+ errors?/.test(tail)) return;
  }
}
