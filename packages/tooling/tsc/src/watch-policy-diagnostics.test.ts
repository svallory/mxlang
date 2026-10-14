import { type ChildProcess, spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { reportWatchPass } from "./index.ts";
import { mxTsc, repoRoot } from "./test-support.ts";

/**
 * `mx-tsc -w` reports host-policy diagnostics (`TS80003`: a `package.json`
 * whose `mx.target` belongs to another host, or an unknown `mx.host`) on every
 * build, the first included, before tsc's summary. An error is counted in the
 * summary; a warning is printed and counted nowhere.
 *
 * They used to be printed once, after the first build's summary and outside its
 * count, and never again: a rebuild that still stood on a bad `package.json`
 * read as one error short, or as clean.
 *
 * Real watchers, each polled, killed and reaped in `finally`, with a hard
 * lifetime limit; run one at a time.
 */
const WAIT_MS = 60_000;
const LIFETIME_MS = 240_000;
const CASE_MS = 300_000;

const SUMMARY = /Found \d+ errors?\. Watching for file changes\./;

interface Watcher {
  /** The output of the next rebuild cycle (after `edited` is written). */
  untilSummary: (edited?: string) => Promise<string>;
  stop: () => Promise<void>;
}

function watchIn(dir: string, args: string[]): Watcher {
  const child: ChildProcess = spawn(
    process.execPath,
    [mxTsc, ...args, "--pretty", "false", "--preserveWatchOutput"],
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
  const lifetime = setTimeout(() => child.kill("SIGKILL"), LIFETIME_MS);
  let output = "";
  let failure: Error | undefined;
  child.on("error", (error) => {
    failure = error;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      output += chunk;
    });
  }
  return {
    untilSummary: async (edited) => {
      const since = output.length;
      const deadline = Date.now() + WAIT_MS;
      let nextTouch = Date.now() + 2_500;
      while (!SUMMARY.test(output.slice(since))) {
        if (failure) throw failure;
        if (
          child.exitCode !== null ||
          child.signalCode !== null ||
          Date.now() > deadline
        ) {
          throw new Error(`watch did not finish a rebuild:\n${output}`);
        }
        // The watcher may not be armed yet: re-touch the edited file until a
        // rebuild starts, never during one.
        if (
          edited &&
          Date.now() >= nextTouch &&
          !output.slice(since).includes("File change detected")
        ) {
          appendFileSync(edited, "\n");
          nextTouch = Date.now() + 2_500;
        }
        await delay(100);
      }
      return output.slice(since);
    },
    stop: async () => {
      clearTimeout(lifetime);
      child.kill("SIGKILL");
      await closed;
    },
  };
}

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const MISMATCH = pretty({
  private: true,
  mx: { host: "solid", target: "react-jsx" },
});
const VALID = pretty({ private: true, mx: { host: "html" } });
const UNKNOWN_HOST = pretty({ private: true, mx: { host: "vue" } });

const MISMATCH_LINE =
  'package.json(5,15): error TS80003: mx.target "react-jsx" belongs to host "react", but mx.host is "solid".';

/** A one-page project whose `package.json` is `packageJson`. */
function project(packageJson: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mx-tsc-watch-policy-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        jsx: "preserve",
        module: "esnext",
        moduleResolution: "bundler",
        target: "esnext",
        types: [],
        allowImportingTsExtensions: true,
        paths: {
          "@mxlang/target-html": [
            join(repoRoot, "packages", "targets", "html", "src", "index.ts"),
          ],
        },
      },
      include: ["src"],
    }),
  );
  writeFileSync(join(dir, "package.json"), packageJson);
  writeFileSync(join(dir, "src", "page.mx"), "<p>ok</p>\n");
  writeFileSync(join(dir, "src", "other.ts"), "export const n = 1;\n");
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  return dir;
}

const occurrences = (text: string, part: string) => text.split(part).length - 1;
const errorLines = (cycle: string) =>
  cycle.split("\n").filter((line) => /\): error /.test(line));
const policyLines = (cycle: string) =>
  cycle.split("\n").filter((line) => /TS80003/.test(line));
const count = (cycle: string) =>
  Number(/Found (\d+) errors?\./.exec(cycle)?.[1]);

/** One cycle whose only host-policy line is `line`, before the summary, counted. */
function expectPolicyError(cycle: string, line: string) {
  expect(policyLines(cycle)).toHaveLength(1);
  expect(occurrences(cycle, line)).toBe(1);
  expect(cycle.indexOf(line)).toBeLessThan(cycle.search(SUMMARY));
  // Every error line of the cycle is in the count, the policy one included.
  expect(count(cycle)).toBe(errorLines(cycle).length);
  expect(errorLines(cycle)).toContainEqual(expect.stringContaining(line));
  expect(cycle.trimEnd().endsWith("Watching for file changes.")).toBe(true);
}

describe("mx-tsc -w host-policy diagnostics", () => {
  it(
    "prints a policy error before the summary on the first build and every rebuild, counts it, and stops once fixed",
    async () => {
      const dir = project(MISMATCH);
      let watcher: Watcher | undefined;
      try {
        const page = join(dir, "src", "page.mx");
        const other = join(dir, "src", "other.ts");
        watcher = watchIn(dir, ["-w", "-p", "tsconfig.json"]);

        expectPolicyError(await watcher.untilSummary(), MISMATCH_LINE);

        // No-op rebuilds of the page and of another file: still reported, once.
        for (const edited of [page, other, page]) {
          expectPolicyError(await watcher.untilSummary(edited), MISMATCH_LINE);
        }

        // Fixed: the page compiles again, resolves the host again, and the
        // error is gone from the line and from the count.
        // The `package.json` write itself starts a rebuild that does not read
        // the page again (so it may still report the old error); the page's
        // edit is the rebuild that resolves the host anew.
        writeFileSync(join(dir, "package.json"), VALID);
        let fixed = await watcher.untilSummary(page);
        for (let n = 0; n < 3 && policyLines(fixed).length > 0; n++) {
          fixed = await watcher.untilSummary(page);
        }
        expect(policyLines(fixed)).toEqual([]);
        expect(errorLines(fixed)).toEqual([]);
        expect(fixed).toContain("Found 0 errors. Watching for file changes.");

        // Broken again: back, counted.
        writeFileSync(join(dir, "package.json"), MISMATCH);
        let broken = await watcher.untilSummary(page);
        for (let n = 0; n < 3 && policyLines(broken).length === 0; n++) {
          broken = await watcher.untilSummary(page);
        }
        expectPolicyError(broken, MISMATCH_LINE);
      } finally {
        await watcher?.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    CASE_MS,
  );

  it(
    "prints a policy warning on every build without counting it",
    async () => {
      const dir = project(UNKNOWN_HOST);
      let watcher: Watcher | undefined;
      try {
        const page = join(dir, "src", "page.mx");
        watcher = watchIn(dir, ["-w", "-p", "tsconfig.json"]);
        const warning = 'warning TS80003: unknown mx.host "vue"';
        for (const edited of [undefined, page, page]) {
          const cycle = await watcher.untilSummary(edited);
          expect(occurrences(cycle, warning)).toBe(1);
          expect(cycle.indexOf(warning)).toBeLessThan(cycle.search(SUMMARY));
          expect(cycle).toContain("Found 0 errors. Watching for file changes.");
          expect(errorLines(cycle)).toEqual([]);
        }
      } finally {
        await watcher?.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    CASE_MS,
  );
});

describe("mx-tsc -w host-policy diagnostics: more cases", () => {
  it(
    "stops reporting a nested package.json's error once the only file under it is deleted",
    async () => {
      const dir = project(VALID);
      let watcher: Watcher | undefined;
      try {
        const sub = join(dir, "src", "sub");
        mkdirSync(sub);
        writeFileSync(join(sub, "package.json"), MISMATCH);
        watcher = watchIn(dir, ["-w", "-p", "tsconfig.json"]);
        expect(await watcher.untilSummary()).toContain("Found 0 errors.");

        const added = join(sub, "x.mx");
        writeFileSync(added, "<p>ok</p>\n");
        const broken = await watcher.untilSummary(added);
        expect(policyLines(broken)).toHaveLength(1);
        expect(policyLines(broken)[0]).toContain("src/sub/package.json");
        expect(count(broken)).toBe(errorLines(broken).length);

        // The rebuild that only removes a root file: tsc may write a TS6053
        // summary first, then the settled one.
        rmSync(added);
        // Both summaries may arrive in one chunk: decide on the last cycle.
        const lastCycle = (text: string) =>
          text.slice(Math.max(text.lastIndexOf("File change detected"), 0));
        let settled = lastCycle(await watcher.untilSummary());
        if (policyLines(settled).length > 0 || count(settled) > 0) {
          settled = lastCycle(await watcher.untilSummary());
        }
        expect(policyLines(settled)).toEqual([]);
        expect(settled).toContain("Found 0 errors. Watching for file changes.");
      } finally {
        await watcher?.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    CASE_MS,
  );

  it(
    "counts a policy error that has no TS80001 pointer (an invalid defaultTag) on every build",
    async () => {
      const dir = project(
        pretty({
          private: true,
          mx: { host: "html", html: { defaultTag: "input" } },
        }),
      );
      let watcher: Watcher | undefined;
      try {
        const page = join(dir, "src", "page.mx");
        watcher = watchIn(dir, ["-w", "-p", "tsconfig.json"]);
        for (const edited of [undefined, page, page]) {
          const cycle = await watcher.untilSummary(edited);
          expect(policyLines(cycle)).toHaveLength(1);
          expect(cycle.indexOf("TS80003")).toBeLessThan(cycle.search(SUMMARY));
          expect(cycle).toContain("Found 1 error. Watching for file changes.");
        }
      } finally {
        await watcher?.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    CASE_MS,
  );
});

describe("reportWatchPass", () => {
  it("fails the exit code on a build with errors and clears it on a clean one", () => {
    const before = process.exitCode;
    const empty = { reports: [], errors: [], warnings: [] };
    try {
      expect(reportWatchPass(empty, [], 1)).toBe(1);
      expect(process.exitCode).toBe(1);
      expect(reportWatchPass(empty, [], 0)).toBe(0);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = before;
    }
  });
});
