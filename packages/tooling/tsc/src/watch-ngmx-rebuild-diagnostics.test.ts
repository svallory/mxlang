import { spawn } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { CASE_TIMEOUT_MS } from "./build-uptodate-support.ts";
import { fixtures, here, mxTsc } from "./test-support.ts";

/**
 * `mx-tsc -w` re-runs the Angular template pass for every rebuild (TODO
 * `mx-tsc-watch-templates`, `tsc-watch-ngmx-rebuild-test`).
 *
 * The pass runs once after the initial build and never again, so a `.ng.mx`
 * broken while the watcher runs was never checked: the rebuild that saw the
 * change reported "Found 0 errors", and a template error only a later rebuild
 * introduced looked like a clean one. That is a silent pass, the one failure
 * mode an agent cannot recover from by reading the output.
 *
 * Mirrors `watch-rebuild-diagnostics.test.ts` (the same bounded real-watcher
 * pattern, for the TypeScript pass): a real watcher, polled, with a hard
 * lifetime limit and a kill in `finally`, so a slow machine fails with "watch
 * did not finish a rebuild" rather than hanging the suite. One watcher at a
 * time.
 */
const WAIT_MS = 60_000;
const MESSAGE =
  "error TS2339: Property 'nmae' does not exist on type '{ name: string; }'.";
/** The `.ng.mx` as the fixture ships it: a template that reads `user.nmae`. */
const BROKEN = "nmae";

it(
  "mx-tsc -w re-checks a .ng.mx template on every rebuild, at its exact position, in the summary count",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-tsc-watch-ngmx-"));
    let stop: (() => Promise<void>) | undefined;
    try {
      cpSync(join(fixtures, "ng-diag-failing"), dir, { recursive: true });
      // `@angular/core` and `@angular/compiler-cli` resolve from the tsc
      // package's own `node_modules` (the checker's resolution rules).
      symlinkSync(join(here, "..", "node_modules"), join(dir, "node_modules"));
      const file = join(dir, "src", "x.component.ng.mx");
      const other = join(dir, "src", "other.ts");
      const clean = readFileSync(file, "utf8").replace(
        `user.${BROKEN}`,
        "user.name",
      );
      writeFileSync(file, clean);
      writeFileSync(other, "export const n = 1;\n");

      const child = spawn(
        process.execPath,
        [
          mxTsc,
          "-w",
          "-p",
          "tsconfig.json",
          "--pretty",
          "false",
          "--preserveWatchOutput",
        ],
        {
          cwd: dir,
          env: {
            ...process.env,
            NO_COLOR: "1",
            TSC_WATCHFILE: "DynamicPriorityPolling",
            TSC_WATCHDIRECTORY: "RecursiveDirectoryUsingDynamicPriorityPolling",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const closed = new Promise<void>((resolve) =>
        child.once("close", () => resolve()),
      );
      const lifetime = setTimeout(() => child.kill("SIGKILL"), 300_000);
      stop = async () => {
        clearTimeout(lifetime);
        child.kill("SIGKILL");
        await closed;
      };
      let output = "";
      let failure: Error | undefined;
      child.on("error", (error) => {
        failure = error;
      });
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const untilSummary = async (since: number, edited?: string) => {
        const deadline = Date.now() + WAIT_MS;
        let nextTouch = Date.now() + 2_500;
        while (
          !/Found \d+ errors?\. Watching for file changes\./.test(
            output.slice(since),
          )
        ) {
          if (failure) throw failure;
          if (
            child.exitCode !== null ||
            child.signalCode !== null ||
            Date.now() > deadline
          ) {
            throw new Error(`watch did not finish a rebuild:\n${output}`);
          }
          // The initial summary can precede watcher arming. Retry a newline
          // only until a rebuild starts; never debounce an ongoing compile.
          if (
            edited &&
            Date.now() >= nextTouch &&
            !output.slice(since).includes("File change detected")
          ) {
            writeFileSync(edited, `${readFileSync(edited, "utf8")}\n`);
            nextTouch = Date.now() + 2_500;
          }
          await delay(100);
        }
        return output.slice(since);
      };
      const exact = `src/x.component.ng.mx(5,18): ${MESSAGE}`;
      const expectBroken = (cycle: string) => {
        expect(
          cycle.split("\n").filter((line) => line.includes("error TS")),
        ).toEqual([exact]);
        // The summary counts the template error: a rebuild that finds one says
        // so, instead of reporting a clean one.
        expect(cycle).toContain("Found 1 error. Watching for file changes.");
      };

      // The initial build is clean, and its summary says so.
      expect(await untilSummary(0)).not.toContain("error TS");

      // Broken after the watcher started: the rebuild that notices must
      // report it, at its exact position, counted in its own summary.
      writeFileSync(file, clean.replace("user.name", `user.${BROKEN}`));
      expectBroken(await untilSummary(output.length, file));

      // No-op rebuilds of the erroring file and of another file keep it: the
      // pass re-runs, so a template error cannot go stale on a rebuild that
      // changed nothing about it.
      for (const edited of [file, other, file]) {
        const since = output.length;
        writeFileSync(edited, `${readFileSync(edited, "utf8")}\n`);
        expectBroken(await untilSummary(since, edited));
      }

      // Fixed: it clears, and the summary counts it as gone.
      let since = output.length;
      writeFileSync(file, clean);
      const fixed = await untilSummary(since, file);
      expect(fixed).not.toContain("error TS");
      expect(fixed).toContain("Found 0 errors. Watching for file changes.");

      // Broken again: back, at the same position.
      since = output.length;
      writeFileSync(file, clean.replace("user.name", `user.${BROKEN}`));
      expectBroken(await untilSummary(since, file));
    } finally {
      // The kill comes first and the close is awaited after the tree is gone:
      // a watcher that never closes must not leave its temp dir behind.
      const closed = stop?.();
      rmSync(dir, { recursive: true, force: true });
      await closed;
    }
  },
  CASE_TIMEOUT_MS,
);
