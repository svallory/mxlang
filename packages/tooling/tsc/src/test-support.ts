import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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
 * `node`, not bun: `runTsc` reads and re-evaluates TypeScript's own `tsc.js`
 * as CommonJS, which bun's loader does not reproduce faithfully.
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

/**
 * Wait until a running `tsc -w` is watching its source directories.
 *
 * tsc prints its first summary from `afterProgramCreate` and only then, still
 * inside the same `synchronizeProgram`, registers the wildcard directory
 * watchers, recording each directory's modification time as it does. A file
 * added or deleted between the summary and that registration changes nothing
 * the poller can see afterwards: no rebuild starts, ever (the cause of the
 * "watch did not finish a rebuild" failures on loaded gates and CI). A test
 * that reacts to the first summary can land in that window, and re-touching a
 * file does not help, since only a directory entry change moves the directory's
 * time.
 *
 * So the first summary is not an "armed" signal. This adds a file under `dir`
 * (a directory the config includes) and, until a rebuild starts, adds another
 * one, since each addition changes the directory again. The rebuild it
 * provokes proves the poller is live; it is waited out so the test starts
 * from a settled watcher. The files stay: they are valid, empty modules.
 *
 * @param output everything the watcher printed so far
 * @param check throws when the watcher died or failed to start
 */
export async function armDirectoryWatch(
  dir: string,
  output: () => string,
  check: () => void,
  budgetMs = 60_000,
): Promise<void> {
  const since = output().length;
  const deadline = Date.now() + budgetMs;
  const settled = /Found \d+ errors?\. Watching for file changes\./;
  let added = 0;
  let nextProbe = 0;
  while (!settled.test(output().slice(since))) {
    check();
    if (Date.now() > deadline) {
      throw new Error(
        `watch never started watching ${dir} within ${budgetMs} ms:\n${output().slice(since) || "(nothing printed)"}`,
      );
    }
    if (
      Date.now() >= nextProbe &&
      !output().slice(since).includes("File change detected")
    ) {
      writeFileSync(join(dir, `armed-${added++}.ts`), "export {};\n");
      nextProbe = Date.now() + 2_500;
    }
    await delay(100);
  }
}
