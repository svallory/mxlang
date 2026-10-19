import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as realSetImmediateFromTimers } from "node:timers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reportWatchPass } from "./index.ts";
import { repoRoot } from "./test-support.ts";
import { type MemoryWatch, watchInMemory } from "./watch-memory.ts";

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
 * The watcher runs in this process over a real project directory, with its
 * rebuilds driven by virtual time (`watch-memory.ts`): tsc's own polling
 * watchers run inside `vi.advanceTimersByTime`, so each rebuild is over
 * the moment its summary is written. Each describe shares one watcher, so its
 * tests run as one sequence of cycles on one project.
 */
const SUMMARY = /Found \d+ errors?\. Watching for file changes\./;

/**
 * The clock the watcher's polls, debounces and build turns run on. Each step
 * hands the event loop a real macrotask (`scripts/vitest-yield.ts`'s medicine,
 * here instead of a config the tests do not own): a synchronous advance would
 * block the worker for a whole test and, on a loaded machine, delay vitest's
 * own RPC past its fixed timeout.
 */
const realSetImmediate = realSetImmediateFromTimers;
const clock = {
  advance: (ms: number) => {
    vi.advanceTimersByTime(ms);
    return new Promise<void>((resolve) => realSetImmediate(resolve));
  },
  clear: () => vi.clearAllTimers(),
};

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const MISMATCH = pretty({
  private: true,
  mx: { host: "solid", target: "react-jsx" },
});
const VALID = pretty({ private: true, mx: { host: "html" } });
const UNKNOWN_HOST = pretty({ private: true, mx: { host: "vue" } });
const BAD_DEFAULT_TAG = pretty({
  private: true,
  mx: { host: "html", html: { defaultTag: "input" } },
});

const MISMATCH_LINE =
  'package.json(5,15): error TS80003: mx.target "react-jsx" belongs to host "react", but mx.host is "solid".';

/**
 * A one-page project whose `package.json` is `packageJson`, in a `project`
 * directory of a temporary one (remove `dirname` of the result). TypeScript
 * watches a `package.json` that is an affecting location of a file only when
 * the path is deeper than the OS-root-like prefix it assumes: `/tmp/x/package.json`
 * is not watched, `/tmp/x/project/package.json` is.
 */
function project(packageJson: string): string {
  const dir = join(
    mkdtempSync(join(tmpdir(), "mx-tsc-watch-policy-")),
    "project",
  );
  mkdirSync(join(dir, "src"), { recursive: true });
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
  let dir: string;
  let watcher: MemoryWatch;
  let firstBuild: string;

  beforeAll(() => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "setImmediate",
        "clearImmediate",
      ],
    });
    dir = project(MISMATCH);
    watcher = watchInMemory(dir, ["-w", "-p", "tsconfig.json"], clock);
    // The first build runs here, not in the first test, so a later case
    // selected with `-t` or `.only` finds the watcher started and settled.
    firstBuild = watcher.start();
  }, 120_000);
  afterAll(() => {
    watcher?.stop();
    vi.useRealTimers();
    rmSync(dirname(dir), { recursive: true, force: true });
  });

  it("prints a policy error before the summary on the first build and every rebuild, counts it, and stops once fixed", async () => {
    const page = join(dir, "src", "page.mx");
    const other = join(dir, "src", "other.ts");

    expectPolicyError(firstBuild, MISMATCH_LINE);

    // No-op rebuilds of the page and of another file: still reported, once.
    for (const edited of [page, other, page]) {
      expectPolicyError(
        await watcher.cycle(() =>
          writeFileSync(edited, readPlusNewline(edited)),
        ),
        MISMATCH_LINE,
      );
    }

    // Fixed: the page compiles again, resolves the host again, and the
    // error is gone from the line and from the count.
    const fixed = await watcher.cycle(() =>
      writeFileSync(join(dir, "package.json"), VALID),
    );
    expect(policyLines(fixed)).toEqual([]);
    expect(errorLines(fixed)).toEqual([]);
    expect(fixed).toContain("Found 0 errors. Watching for file changes.");

    // Broken again: back, counted.
    const broken = await watcher.cycle(() =>
      writeFileSync(join(dir, "package.json"), MISMATCH),
    );
    expectPolicyError(broken, MISMATCH_LINE);
  }, 120_000);

  // The cases of this describe run in order: each settles the project into
  // the state the next one assumes. The watcher's first build holds the
  // MISMATCH error, so the cases below assert on *rebuilds*: a warning (or a
  // pointer-less error) printed by the first build shares the interceptor
  // path with the error test 1 covers on the first build.
  it("prints a policy warning on every rebuild without counting it", async () => {
    const page = join(dir, "src", "page.mx");
    const warning = 'warning TS80003: unknown mx.host "vue"';
    const warned = await watcher.cycle(() =>
      writeFileSync(join(dir, "package.json"), UNKNOWN_HOST),
    );
    expect(occurrences(warned, warning)).toBe(1);
    expect(warned.indexOf(warning)).toBeLessThan(warned.search(SUMMARY));
    expect(warned).toContain("Found 0 errors. Watching for file changes.");
    expect(errorLines(warned)).toEqual([]);

    for (const _ of [1, 2]) {
      const cycle = await watcher.cycle(() =>
        writeFileSync(page, readPlusNewline(page)),
      );
      expect(occurrences(cycle, warning)).toBe(1);
      expect(cycle.indexOf(warning)).toBeLessThan(cycle.search(SUMMARY));
      expect(cycle).toContain("Found 0 errors. Watching for file changes.");
      expect(errorLines(cycle)).toEqual([]);
    }
  }, 120_000);
});

describe("mx-tsc -w host-policy diagnostics: more cases", () => {
  // The cases of this describe run in order on one watcher.
  let dir: string;
  let watcher: MemoryWatch;
  let firstBuild: string;

  beforeAll(() => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "setImmediate",
        "clearImmediate",
      ],
    });
    dir = project(VALID);
    const sub = join(dir, "src", "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, "package.json"), MISMATCH);
    watcher = watchInMemory(dir, ["-w", "-p", "tsconfig.json"], clock);
    firstBuild = watcher.start();
  }, 120_000);
  afterAll(() => {
    watcher?.stop();
    vi.useRealTimers();
    rmSync(dirname(dir), { recursive: true, force: true });
  });

  it("stops reporting a nested package.json's error once the only file under it is deleted", async () => {
    expect(firstBuild).toContain("Found 0 errors.");

    const added = join(dir, "src", "sub", "x.mx");
    const broken = await watcher.cycle(() =>
      writeFileSync(added, "<p>ok</p>\n"),
    );
    expect(policyLines(broken)).toHaveLength(1);
    expect(policyLines(broken)[0]).toContain("src/sub/package.json");
    expect(count(broken)).toBe(errorLines(broken).length);

    // The rebuild that only removes a root file: tsc may write a TS6053
    // summary first, then the settled one. Both summaries may arrive in one
    // advance: decide on the last cycle.
    const lastCycle = (text: string) =>
      text.slice(Math.max(text.lastIndexOf("File change detected"), 0));
    rmSync(added);
    let settled = lastCycle(await watcher.cycle());
    if (policyLines(settled).length > 0 || count(settled) > 0) {
      settled = lastCycle(await watcher.cycle());
    }
    expect(policyLines(settled)).toEqual([]);
    expect(settled).toContain("Found 0 errors. Watching for file changes.");
  }, 120_000);

  it("counts a policy error that has no TS80001 pointer (an invalid defaultTag) on every rebuild", async () => {
    const page = join(dir, "src", "page.mx");
    for (const edited of [undefined, page, page]) {
      const act =
        edited === undefined
          ? () => writeFileSync(join(dir, "package.json"), BAD_DEFAULT_TAG)
          : () => writeFileSync(edited, readPlusNewline(edited));
      const cycle = await watcher.cycle(act);
      expect(policyLines(cycle)).toHaveLength(1);
      expect(cycle.indexOf("TS80003")).toBeLessThan(cycle.search(SUMMARY));
      expect(cycle).toContain("Found 1 error. Watching for file changes.");
    }
  }, 120_000);
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

/** The file's text with one more newline: a no-op edit that changes the mtime. */
function readPlusNewline(path: string): string {
  return `${readFileSync(path, "utf8")}\n`;
}
