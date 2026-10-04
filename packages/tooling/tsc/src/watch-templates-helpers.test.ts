import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type BuildProject,
  isWatchMode,
  matchProjects,
  resolveBuildProjects,
} from "./build-templates.ts";
import { fixtures, here } from "./test-support.ts";
import { recountWatchSummary } from "./watch-templates.ts";

describe("recountWatchSummary", () => {
  it("raises the count of tsc's own summary, keeping its timestamp and newlines", () => {
    expect(
      recountWatchSummary(
        "\n10:42:50 PM - Found 0 errors. Watching for file changes.\n\n",
        1,
      ),
    ).toBe("\n10:42:50 PM - Found 1 error. Watching for file changes.\n\n");
    expect(
      recountWatchSummary(
        "\n10:42:50 PM - Found 2 errors. Watching for file changes.\n\n",
        3,
      ),
    ).toBe("\n10:42:50 PM - Found 5 errors. Watching for file changes.\n\n");
  });

  it("counts the pretty reporter's bracketed timestamp too", () => {
    expect(
      recountWatchSummary(
        "[10:42:50 PM] Found 1 error. Watching for file changes.\n\n",
        1,
      ),
    ).toBe("[10:42:50 PM] Found 2 errors. Watching for file changes.\n\n");
  });

  it("leaves everything that is not a summary alone, including a diagnostic quoting one", () => {
    const diagnostic =
      "src/watch.test.ts(9,5): error TS2322: Type 'string' is not assignable to type 'number'.\n";
    expect(recountWatchSummary(diagnostic, 1)).toBeUndefined();
    // A test asserting on this very line compiles under `mx-tsc` too, so a
    // diagnostic whose message quotes the summary must not be recounted.
    expect(
      recountWatchSummary(
        "src/w.test.ts(9,5): error TS2550: expected 'Found 0 errors. Watching for file changes.' to be 'Found 1 errors. Watching for file changes.'\n",
        1,
      ),
    ).toBeUndefined();
  });
});

/**
 * The two decisions the Angular template pass makes per watch rebuild, without
 * a watcher: whether `argv` watches at all (which installs the interceptor), and
 * which project of a `-b` graph each program belongs to (which tsconfig each
 * project's templates are checked under). Both decide ownership from what tsc
 * itself resolved, never from a path prefix.
 */
describe("isWatchMode", () => {
  const cwd = join(here, "fixtures", "ng-build-refs", "app");

  it.each([
    [["-w", "-p", "tsconfig.json"], true],
    [["--watch", "-p", "tsconfig.json"], true],
    [["-w", "-p", "tsconfig.json", "--pretty", "false"], true],
    [["-b", "-w", "."], true],
    [["-b", "--watch", "."], true],
    [["--build", "-w", "."], true],
    [["-p", "tsconfig.json"], false],
    [["-b", "."], false],
    [[], false],
    [["--help"], false],
  ])("%s watches: %s", (argv, expected) => {
    expect(isWatchMode(argv, cwd)).toBe(expected);
  });
});

describe("matchProjects", () => {
  const project = (
    tsconfigPath: string,
    rootNames: string[],
  ): BuildProject => ({
    tsconfigPath,
    hasFiles: rootNames.length > 0,
    rootNames,
  });
  const lib = project("/p/lib/tsconfig.json", ["/p/lib/a.ts", "/p/lib/b.ts"]);
  const app = project("/p/app/tsconfig.json", ["/p/app/main.ts"]);
  const projects = [lib, app];

  it("matches each program to the project whose file list it is, on the most root files held", () => {
    expect(
      matchProjects(projects, [
        ["/p/lib/a.ts", "/p/lib/b.ts"],
        ["/p/app/main.ts"],
      ]),
    ).toEqual([0, 1]);
  });

  it("matches a program of import-only files through the roots it does hold", () => {
    // `.ng.mx` files the tsconfig's `include` never lists are still compiled
    // by their program, and that program is the project's.
    expect(matchProjects(projects, [["/p/lib/a.ts"]])).toEqual([0]);
  });

  it("reports -1 for a program no project holds, rather than guessing", () => {
    expect(matchProjects(projects, [["/elsewhere/x.ts"]])).toEqual([-1]);
    expect(matchProjects(projects, [[]])).toEqual([-1]);
  });

  it("resolves a graph's projects with the file lists it matches on", () => {
    const solution = join(fixtures, "ng-build-solution");
    const resolved = resolveBuildProjects(["-b", "."], solution);
    expect(
      resolved.map((p) => [dirname(p.tsconfigPath), p.rootNames.length]),
    ).toEqual([
      [join(solution, "lib"), 2],
      [join(solution, "app"), 1],
      [solution, 0],
    ]);
  });
});
