import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
    env: { ...process.env, NO_COLOR: "1" },
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
  const pkg = join(dir, "node_modules", "late-pkg");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    '{ "name": "late-pkg", "types": "index.d.ts" }',
  );
  writeFileSync(
    join(pkg, "index.d.ts"),
    "export declare const late: number;\n",
  );
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
        importsOf(
          dir,
          'import { late } from "late-pkg";\nexport const a: number = late;\n// touch\n',
        );
        await run.until(/Found 0 errors/, mark);
      },
      CASE_TIMEOUT_MS,
    );
  }

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
