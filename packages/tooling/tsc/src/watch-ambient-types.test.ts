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
    const lines = (text: string) =>
      text.split("\n").filter((line) => line.includes("TS80004"));
    // The builds that follow `since`, up to and including the first one that
    // ends in `Found <count> error(s). Watching for file changes.`. The host's
    // error goes to stderr and tsc's summary to stdout, two pipes that reach
    // the capture in either order, so a build that should throw is waited for
    // until both are in, and its text runs to the next build's start, not to
    // its summary. A clean build is waited for by counts instead (see
    // `settled`). Returns the last build for a throwing one; any before it is
    // checked below.
    //
    // Removing a root file can take tsc through two builds. The file's own
    // watcher and the directory watcher poll independently: when the file's
    // fires first, tsc rebuilds with the root list it still holds, so the file
    // is `TS6053` missing, and the host (asked only when the root list changes)
    // keeps its last answer, which is the throw. The directory watcher then
    // triggers the build that re-reads the list. So the build waited for is the
    // one with the expected count, and any before it must be that missing-root
    // one.
    const untilBuild = async (since: number, count: 0 | 1) => {
      const summary = count === 0 ? "Found 0 errors" : "Found 1 error";
      const done = `${summary}\\. Watching for file changes\\.`;
      const strip = (text: string) => stripVTControlCharacters(text);
      // A clean build is waited for by counts: every missing-root build before
      // it said the host's error once, and the pipe that carries it can land
      // after the clean build's own summary, so no line is placed by position.
      const settled = (text: string) => {
        const seen = strip(text);
        if (!new RegExp(done).test(seen)) return false;
        return count === 1
          ? seen.includes("TS80004")
          : lines(seen).length === seen.split("error TS6053").length - 1;
      };
      const out = strip(await run.until(settled, since, WAIT_MS)).slice(since);
      const end = out.search(new RegExp(done)) + summary.length;
      const builds = out.slice(0, end).split("File change detected").slice(1);
      for (const earlier of builds.slice(0, -1)) {
        expect(earlier).toContain("error TS6053");
      }
      if (count === 0) {
        expect(lines(out)).toEqual(Array(builds.length - 1).fill(DIAGNOSTIC));
        return "";
      }
      const next = out.indexOf("File change detected", end);
      return out.slice(
        out.lastIndexOf("File change detected", end),
        next < 0 ? out.length : next,
      );
    };
    const touchIndex = () => appendFileSync(index, "\n");
    try {
      // The first build holds `throw.ts`, and so does every rebuild arming
      // caused (content-only: the host is not asked again, but its program
      // still lacks the host's files: said again). The helper has waited until
      // the output stopped changing, so every line is in; counted over all of
      // it, since which build a line from the other pipe lands in is not fixed.
      const all = stripVTControlCharacters(run.output());
      const builds = all.split("File change detected").length - 1;
      expect(builds).toBeGreaterThan(0);
      expect(lines(all)).toEqual(Array(builds + 1).fill(DIAGNOSTIC));
      expect(all.split("Found 1 error.").length - 1).toBe(builds + 1);
      // `throw.ts` removed: the root list changed, the host is asked, answers.
      let since = run.output().length;
      rmSync(thrower);
      await untilBuild(since, 0);
      since = run.output().length;
      touchIndex();
      await untilBuild(since, 0);
      // Back: the host throws on a rebuild, not only on the first build. The
      // root comes back through a config edit, not by creating `throw.ts`:
      // plain `tsc -w` (no mx-tsc, same polling settings, 24 busy loops on a
      // 10-core machine) builds once after a removed root is created again
      // and reports it `TS6053` missing for good, in 8 of 8 runs. When TypeScript is
      // bumped, re-check that with stock `tsc -w`; if it no longer sticks,
      // restore a re-created `throw.ts` here.
      since = run.output().length;
      writeFileSync(
        project.path("tsconfig.json"),
        tsconfig(["*.ts", "spare/*.ts"]),
      );
      expect(lines(await untilBuild(since, 1))).toEqual([DIAGNOSTIC]);
    } finally {
      await run.stop();
    }
  },
  TIMEOUT_MS,
);
