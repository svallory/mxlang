import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CASE_TIMEOUT_MS,
  cliFixture,
  importsOf,
  mxTsc,
  privateNodeModules,
  scratch,
} from "./build-uptodate-support.ts";

/**
 * Watch timing differs by platform, and so does tsc's own behaviour (see the
 * `-w -p` case), so nothing here asserts more than tsc itself does: a module
 * is installed with one atomic rename (no half-written package for a rebuild
 * to catch) and recovery is asserted on that install alone, with no edit to
 * the importer. tsc is told to poll (`TSC_WATCHFILE` / `TSC_WATCHDIRECTORY`)
 * to keep timing steady; that does not remove the platform difference.
 *
 * Watch modes keep tsc's own failed-lookup watching only while the host's
 * resolver stays in charge: a module that is missing and then installed must
 * clear its TS2307 without restarting the watcher, and `-b -w` must still
 * resolve an extensionless `.ng.mx` import.
 */
const WAIT_MS = 60_000;
/**
 * Gap between touches while waiting for the watchers to arm. tsc debounces a
 * burst of changes by resetting a 250 ms timer on each one, and its dynamic
 * polling can lag a touch by up to 2 s, so touching faster than that can keep
 * resetting the rebuild forever and the touches never produce a rebuild.
 */
const TOUCH_EVERY_MS = 2_500;
/**
 * How long tsc gets to arm its watchers after printing the first summary. Under
 * load (several tsc processes at once) that took ~58 s, so it is generous.
 */
const ARM_WAIT_MS = 150_000;
/**
 * Vitest timeout of the `-b -w` late-install case: first build (`WAIT_MS`) +
 * arming (`ARM_WAIT_MS`) + recovery (`WAIT_MS`) + 30 s slack = 300 s, so a
 * slow but correct run fails with "watch never armed", not a test timeout.
 */
const LATE_INSTALL_TIMEOUT_MS = 2 * WAIT_MS + ARM_WAIT_MS + 30_000;
/** How long a late install gets to be noticed before it counts as never. */
const PARITY_WAIT_MS = 15_000;
const plainTsc = createRequire(import.meta.url).resolve(
  "typescript/lib/tsc.js",
);
const LATE_IMPORT =
  'import { late } from "late-pkg";\nexport const a: number = late;\n';
const running: ChildProcess[] = [];

afterEach(() => {
  for (const child of running.splice(0)) child.kill("SIGKILL");
});

function watch(cwd: string, args: string[], entry = mxTsc) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      TSC_WATCHFILE: "DynamicPriorityPolling",
      TSC_WATCHDIRECTORY: "RecursiveDirectoryUsingDynamicPriorityPolling",
    },
  });
  running.push(child);
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return {
    output: () => output,
    /** Resolves once `output` matches; rejects with the output on timeout. */
    async until(
      pattern: RegExp,
      since = 0,
      timeoutMs = WAIT_MS,
    ): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pattern.test(output.slice(since))) return output;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`timed out waiting for ${pattern}:\n${output}`);
    },
    /**
     * Resolves once tsc's watchers are armed, proven by tsc rebuilding after a
     * touch of `file`. The first "Found N errors" line is printed *before*
     * `-b -w` creates its watchers, and creating them walks every directory
     * under the project (slow under load), so a change made right after that
     * line can land before the watchers take their baseline and is never
     * reported. A touch that tsc reports is the only observable "armed" signal;
     * the touch is repeated because the early ones may land before arming.
     */
    async armed(file: string, timeoutMs = ARM_WAIT_MS): Promise<void> {
      const since = output.length;
      let lastTail = "";
      const deadline = Date.now() + timeoutMs;
      while (!/File change detected/.test(output.slice(since))) {
        if (Date.now() > deadline) {
          throw new Error(`watch never armed:\n${output}`);
        }
        const now = new Date();
        utimesSync(file, now, now);
        await new Promise((resolve) => setTimeout(resolve, TOUCH_EVERY_MS));
      }
      // Let the rebuilds the touches caused finish (the loop above can touch
      // once more after the first rebuild started), so none of them can be
      // mistaken for, or overlap, the one the install causes.
      let settled = 0;
      while (settled < 8) {
        if (Date.now() > deadline) {
          throw new Error(`rebuild never settled:\n${output}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        const tail = output.slice(output.lastIndexOf("File change detected"));
        settled =
          /Found \d+ errors?/.test(tail) && tail === lastTail ? settled + 1 : 0;
        lastTail = tail;
      }
    },
  };
}

function installLatePackage(dir: string) {
  const staged = join(dir, "staged", "late-pkg");
  mkdirSync(staged, { recursive: true });
  writeFileSync(
    join(staged, "package.json"),
    '{ "name": "late-pkg", "types": "index.d.ts" }',
  );
  writeFileSync(
    join(staged, "index.d.ts"),
    "export declare const late: number;\n",
  );
  renameSync(staged, join(dir, "node_modules", "late-pkg"));
}

describe("mx-tsc watch modes", () => {
  it(
    "-b -w: a module that is missing and then installed stops being TS2307",
    async () => {
      const dir = scratch(cliFixture);
      privateNodeModules(dir);
      importsOf(dir, LATE_IMPORT);
      const run = watch(dir, [
        "-b",
        "-w",
        "tsconfig.app.json",
        "--preserveWatchOutput",
      ]);
      await run.until(/TS2307[^\n]*late-pkg[\s\S]*Found 1 error/);
      await run.armed(join(dir, "src", "main.ts"));
      const mark = run.output().length;
      installLatePackage(dir);
      await run.until(/Found 0 errors/, mark);
    },
    LATE_INSTALL_TIMEOUT_MS,
  );

  // Plain `tsc -w -p` (TypeScript 6.0.3) does not recover from a module
  // installed after the first error on Linux (it does on macOS); `-b -w` does on
  // both. So `-w -p` is asserted as parity with plain tsc, never as recovery:
  // mx-tsc must lose none of tsc's failed-lookup watching, and gain none either.
  // See scratch/reports/review-mx-tsc-build-extensionless-resolve-r3.md.
  it(
    "-w -p: recovers from a late install exactly when plain tsc -w -p does",
    async () => {
      const recovered = async (entry: string) => {
        const dir = scratch(cliFixture);
        privateNodeModules(dir);
        importsOf(dir, LATE_IMPORT);
        const run = watch(
          dir,
          ["-w", "-p", "tsconfig.app.json", "--preserveWatchOutput"],
          entry,
        );
        await run.until(/TS2307[^\n]*late-pkg[\s\S]*Found 1 error/);
        const mark = run.output().length;
        installLatePackage(dir);
        try {
          await run.until(/Found 0 errors/, mark, PARITY_WAIT_MS);
          return true;
        } catch {
          return false;
        }
      };
      const [mx, plain] = await Promise.all([
        recovered(mxTsc),
        recovered(plainTsc),
      ]);
      expect(mx).toBe(plain);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "-p -w picks the template, as -p does, when x.d.ts sits beside x.ng.mx",
    async () => {
      const dir = scratch(cliFixture);
      writeFileSync(
        join(dir, "src", "app.component.d.ts"),
        "export declare const AppComponent: string;\n",
      );
      importsOf(
        dir,
        'import { AppComponent } from "./app.component";\nexport const s: string = AppComponent;\n',
      );
      const run = watch(dir, [
        "-w",
        "-p",
        "tsconfig.app.json",
        "--preserveWatchOutput",
      ]);
      const output = await run.until(/Found \d+ errors?/);
      expect(output).toContain("TS2322");
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "-b -w resolves an extensionless .ng.mx import",
    async () => {
      const dir = scratch(cliFixture);
      importsOf(
        dir,
        'import { AppComponent } from "./app.component.ng";\nexport const c = AppComponent;\n',
      );
      const run = watch(dir, [
        "-b",
        "-w",
        "tsconfig.app.json",
        "--preserveWatchOutput",
      ]);
      const output = await run.until(/Found \d+ errors?/);
      expect(output).not.toContain("TS2307");
      expect(output).toMatch(/Found 0 errors/);
    },
    CASE_TIMEOUT_MS,
  );
});
