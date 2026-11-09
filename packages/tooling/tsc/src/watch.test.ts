import { mkdirSync, renameSync, writeFileSync } from "node:fs";
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
import {
  type SpawnedWatch,
  spawnWatch,
  WATCH_ARM_MS,
  WATCH_FIRST_SUMMARY_MS,
} from "./test-support.ts";

/**
 * Watch timing differs by platform, and so does tsc's own behaviour (see the
 * `-w -p` case), so nothing here asserts more than tsc itself does: a module
 * is installed with one atomic rename (no half-written package for a rebuild
 * to catch) and recovery is asserted on that install alone, with no edit to
 * the importer after the install (arming appends newlines to it before). tsc
 * is told to poll (`TSC_WATCHFILE` / `TSC_WATCHDIRECTORY`) to keep timing
 * steady; that does not remove the platform difference.
 *
 * Watch modes keep tsc's own failed-lookup watching only while the host's
 * resolver stays in charge: a module that is missing and then installed must
 * clear its TS2307 without restarting the watcher, and `-b -w` must still
 * resolve an extensionless `.ng.mx` import.
 */
/**
 * Vitest timeout of the `-b -w` late-install case: first build + arming (both
 * the helper's budgets) + recovery (`WATCH_FIRST_SUMMARY_MS`) + 30 s slack, so
 * a slow but correct run fails with "watch never armed", not a test timeout.
 */
const LATE_INSTALL_TIMEOUT_MS =
  2 * WATCH_FIRST_SUMMARY_MS + WATCH_ARM_MS + 30_000;
/** How long a late install gets to be noticed before it counts as never. */
const PARITY_WAIT_MS = 15_000;
const plainTsc = createRequire(import.meta.url).resolve(
  "typescript/lib/tsc.js",
);
const LATE_IMPORT =
  'import { late } from "late-pkg";\nexport const a: number = late;\n';
const running: SpawnedWatch[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((w) => w.stop()));
});

/**
 * Spawns a watcher that `afterEach` stops. `lifetimeMs` is the case's vitest
 * timeout, so a watcher still arming when the case fails or times out (and is
 * never pushed onto `running`) dies on its own.
 */
async function tracked(
  cwd: string,
  args: string[],
  lifetimeMs: number,
  options: { entry?: string; armFile?: string } = {},
) {
  const w = await spawnWatch({ cwd, args, lifetimeMs, ...options });
  running.push(w);
  return w;
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
      const run = await tracked(
        dir,
        ["-b", "-w", "tsconfig.app.json", "--preserveWatchOutput"],
        LATE_INSTALL_TIMEOUT_MS,
        { armFile: join(dir, "src", "main.ts") },
      );
      await run.until(/TS2307[^\n]*late-pkg[\s\S]*Found 1 error/);
      const mark = run.output().length;
      installLatePackage(dir);
      await run.until(/Found 0 errors/, mark);
    },
    LATE_INSTALL_TIMEOUT_MS,
  );

  // Plain `tsc -w -p` (TypeScript 6.0.3) was observed, before the shared
  // arming helper, not to recover from a module installed after the first
  // error on Linux (it did on macOS); `-b -w` did on both. So `-w -p` is
  // asserted as parity with plain tsc, never as recovery: mx-tsc must lose
  // none of tsc's failed-lookup watching, and gain none either.
  it(
    "-w -p: recovers from a late install exactly when plain tsc -w -p does",
    async () => {
      // Phase 1 spawns and arms both children; phase 2 installs and waits, so
      // one child's arming load cannot land in the other's wait window.
      const armedRun = async (entry: string) => {
        const dir = scratch(cliFixture);
        privateNodeModules(dir);
        importsOf(dir, LATE_IMPORT);
        const run = await tracked(
          dir,
          ["-w", "-p", "tsconfig.app.json", "--preserveWatchOutput"],
          CASE_TIMEOUT_MS,
          { entry, armFile: join(dir, "src", "main.ts") },
        );
        await run.until(/TS2307[^\n]*late-pkg[\s\S]*Found 1 error/);
        return { dir, run };
      };
      const recovered = async ({
        dir,
        run,
      }: Awaited<ReturnType<typeof armedRun>>) => {
        const mark = run.output().length;
        installLatePackage(dir);
        try {
          await run.until(/Found 0 errors/, mark, PARITY_WAIT_MS);
          return true;
        } catch {
          return false;
        }
      };
      const armed = await Promise.allSettled([
        armedRun(mxTsc),
        armedRun(plainTsc),
      ]);
      const runs = armed.flatMap((r) =>
        r.status === "fulfilled" ? [r.value] : [],
      );
      const failed = armed.find((r) => r.status === "rejected");
      if (failed) {
        // The other run may have armed: stop it before failing the case.
        await Promise.all(runs.map(({ run }) => run.stop()));
        throw failed.reason;
      }
      const [mxRun, plainRun] = runs as [(typeof runs)[0], (typeof runs)[0]];
      const [mx, plain] = await Promise.all([
        recovered(mxRun),
        recovered(plainRun),
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
      const run = await tracked(
        dir,
        ["-w", "-p", "tsconfig.app.json", "--preserveWatchOutput"],
        CASE_TIMEOUT_MS,
      );
      const output = run.output();
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
      const run = await tracked(
        dir,
        ["-b", "-w", "tsconfig.app.json", "--preserveWatchOutput"],
        CASE_TIMEOUT_MS,
      );
      const output = run.output();
      expect(output).not.toContain("TS2307");
      expect(output).toMatch(/Found 0 errors/);
    },
    CASE_TIMEOUT_MS,
  );
});
