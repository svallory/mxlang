import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
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
 * Watch timing is the one thing that differs by platform (inotify, FSEvents),
 * so these cases do not depend on it: tsc is told to poll files and
 * directories itself (`TSC_WATCHFILE` / `TSC_WATCHDIRECTORY`), a module is
 * installed with one atomic rename (no half-written package for a rebuild to
 * catch), and recovery is asserted on that install alone, with no edit to the
 * importer to trigger the rebuild.
 *
 * Watch modes keep tsc's own failed-lookup watching only while the host's
 * resolver stays in charge: a module that is missing and then installed must
 * clear its TS2307 without restarting the watcher, and `-b -w` must still
 * resolve an extensionless `.ng.mx` import.
 */
const WAIT_MS = 60_000;
const running: ChildProcess[] = [];

afterEach(() => {
  for (const child of running.splice(0)) child.kill("SIGKILL");
});

function watch(cwd: string, args: string[]) {
  const child = spawn(process.execPath, [mxTsc, ...args], {
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
    async until(pattern: RegExp, since = 0): Promise<string> {
      const deadline = Date.now() + WAIT_MS;
      while (Date.now() < deadline) {
        if (pattern.test(output.slice(since))) return output;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`timed out waiting for ${pattern}:\n${output}`);
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
  for (const [mode, args] of [
    ["-w -p", ["-w", "-p", "tsconfig.app.json", "--preserveWatchOutput"]],
    ["-b -w", ["-b", "-w", "tsconfig.app.json", "--preserveWatchOutput"]],
  ] as const) {
    it(
      `${mode}: a module that is missing and then installed stops being TS2307`,
      async () => {
        const dir = scratch(cliFixture);
        privateNodeModules(dir);
        importsOf(
          dir,
          'import { late } from "late-pkg";\nexport const a: number = late;\n',
        );
        const run = watch(dir, [...args]);
        await run.until(/TS2307[^\n]*late-pkg[\s\S]*Found 1 error/);
        const mark = run.output().length;
        installLatePackage(dir);
        await run.until(/Found 0 errors/, mark);
      },
      CASE_TIMEOUT_MS,
    );
  }

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
