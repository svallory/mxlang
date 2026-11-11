import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupProjects,
  fakeProject,
  specifier,
} from "../../../../test-fixtures/third-party-targets/support.ts";
import { reportWatchPass } from "./index.ts";
import {
  spawnWatch,
  WATCH_ARM_MS,
  WATCH_FIRST_SUMMARY_MS,
} from "./test-support.ts";

/**
 * `mx-tsc -w` with a host whose `ambientTypes` throws only while the program
 * holds a root file named `throw.ts` (the `ambient-types-misbehaves` fake):
 * every build that runs without the host's files says so, counted in that
 * build's summary, and a build that asks the host again and gets an answer is
 * clean.
 */
const DIAGNOSTIC =
  "error TS80004: host @fake/mx-ambient-types-misbehaves: ambientTypes threw: asked to throw";
const WAIT_MS = 30_000;
/** First build + arming (the helper's budgets) + three rebuilds + slack. */
const TIMEOUT_MS = WATCH_FIRST_SUMMARY_MS + WATCH_ARM_MS + 3 * WAIT_MS + 30_000;
const tsconfig = (include: string[]) =>
  JSON.stringify({
    compilerOptions: {
      noEmit: true,
      strict: true,
      module: "esnext",
      target: "es2022",
      types: [],
    },
    include,
  });
const EMPTY = { reports: [], errors: [], warnings: [] };

afterEach(cleanupProjects);

describe("reportWatchPass", () => {
  it("counts the ambientTypes errors, sets the exit code, and clears it on a clean build", () => {
    const written: string[] = [];
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      });
    const before = process.exitCode;
    try {
      expect(
        reportWatchPass(EMPTY, ["host @fake/x: ambientTypes threw: boom"]),
      ).toBe(1);
      expect(process.exitCode).toBe(1);
      expect(stripVTControlCharacters(written.join(""))).toContain(
        "error TS80004: host @fake/x: ambientTypes threw: boom",
      );

      written.length = 0;
      expect(reportWatchPass(EMPTY, [])).toBe(0);
      expect(process.exitCode).toBe(0);
      expect(written.join("")).toBe("");
    } finally {
      write.mockRestore();
      process.exitCode = before;
    }
  });
});

it(
  "mx-tsc -w reports a throwing host on every build while it throws, and not after",
  async () => {
    const project = fakeProject({
      mx: { target: specifier("ambient-types-misbehaves") },
      install: ["ambient-types-misbehaves"],
      files: {
        "tsconfig.json": tsconfig(["*.ts"]),
        "index.ts": "export const answer: number = 42;\n",
        "throw.ts": "export const thrown = true;\n",
      },
    });
    // Outside the program until the last step brings it in.
    mkdirSync(project.path("spare"));
    writeFileSync(
      project.path("spare/throw.ts"),
      "export const thrown = true;\n",
    );
    const index = project.path("index.ts");
    const thrower = project.path("throw.ts");
    const run = await spawnWatch({
      cwd: project.root,
      args: ["-w", "-p", "tsconfig.json", "--preserveWatchOutput"],
      armFile: index,
      lifetimeMs: TIMEOUT_MS - 10_000,
    });
    // One build's output, up to its summary.
    const untilSummary = async (since: number) => {
      await run.until(
        /Found \d+ errors?\. Watching for file changes\./,
        since,
        WAIT_MS,
      );
      return stripVTControlCharacters(run.output().slice(since));
    };
    // Removing a root file can take tsc through two builds. The file's own
    // watcher and the directory watcher poll independently: when the file's
    // fires first, tsc rebuilds with the root list it still holds, so the file
    // is `TS6053` missing, and the host (asked only when the root list changes)
    // keeps its last answer, which is the throw. The directory watcher then
    // triggers the build that re-reads the list. So wait for the clean build,
    // and require any build before it to be that missing-root one. (A created
    // file is not waited on this way: tsc can keep reporting it missing, so the
    // host comes back through a config edit.)
    const untilClean = async (since: number) => {
      await run.until(
        /Found 0 errors\. Watching for file changes\./,
        since,
        WAIT_MS,
      );
      const builds = stripVTControlCharacters(run.output().slice(since))
        .split("File change detected")
        .slice(1);
      for (const earlier of builds.slice(0, -1)) {
        expect(earlier).toContain("error TS6053");
      }
      return builds[builds.length - 1] ?? "";
    };
    const lines = (build: string) =>
      build.split("\n").filter((line) => line.includes("TS80004"));
    const expectThrown = (build: string) => {
      expect(lines(build)).toEqual([DIAGNOSTIC]);
      // Printed before the summary that counts it.
      expect(build.indexOf(DIAGNOSTIC)).toBeLessThan(
        build.indexOf("Found 1 error."),
      );
      expect(build).toContain("Found 1 error.");
    };
    const expectClean = (build: string) => {
      expect(lines(build)).toEqual([]);
      expect(build).toContain("Found 0 errors.");
    };
    const touchIndex = () => appendFileSync(index, "\n");
    try {
      // The first build holds `throw.ts`: cut the output at its summary.
      const first = stripVTControlCharacters(run.output());
      const firstEnd = first.indexOf("Watching for file changes.");
      expectThrown(first.slice(0, firstEnd));
      // Arming touched `index.ts`: a rebuild it caused is content-only, so the
      // host is not asked again, but its program still lacks the host's files:
      // said again. Only the last arming rebuild is asserted: stdout and stderr
      // interleave in arrival order, so an earlier one's split is not exact.
      const armed = first
        .slice(firstEnd)
        .split("File change detected")
        .slice(1);
      expect(armed.length).toBeGreaterThan(0);
      expectThrown(armed[armed.length - 1] ?? "");
      // `throw.ts` removed: the root list changed, the host is asked, answers.
      let since = run.output().length;
      rmSync(thrower);
      expectClean(await untilClean(since));
      since = run.output().length;
      touchIndex();
      expectClean(await untilSummary(since));
      // Back: the host throws on a rebuild, not only on the first build.
      since = run.output().length;
      writeFileSync(
        project.path("tsconfig.json"),
        tsconfig(["*.ts", "spare/*.ts"]),
      );
      expectThrown(await untilSummary(since));
    } finally {
      await run.stop();
    }
  },
  TIMEOUT_MS,
);
