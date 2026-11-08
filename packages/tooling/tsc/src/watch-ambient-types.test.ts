import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupProjects,
  fakeProject,
  specifier,
} from "../../../../test-fixtures/third-party-targets/support.ts";
import { reportWatchPass } from "./index.ts";
import { spawnWatch } from "./test-support.ts";

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

it("mx-tsc -w reports a throwing host on every build while it throws, and not after", async () => {
  const project = fakeProject({
    mx: { target: specifier("ambient-types-misbehaves") },
    install: ["ambient-types-misbehaves"],
    files: {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          noEmit: true,
          strict: true,
          module: "esnext",
          target: "es2022",
          types: [],
        },
        include: ["*.ts"],
      }),
      "index.ts": "export const answer: number = 42;\n",
      "throw.ts": "export const thrown = true;\n",
    },
  });
  const index = project.path("index.ts");
  const thrower = project.path("throw.ts");
  const run = await spawnWatch({
    cwd: project.root,
    args: ["-w", "-p", "tsconfig.json", "--preserveWatchOutput"],
    armFile: index,
    lifetimeMs: 110_000,
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
    // The first build holds `throw.ts`. Arming touched `index.ts`, so cut the
    // output at the first summary to keep those rebuilds out of it.
    const firstEnd = run.output().indexOf("Watching for file changes.");
    expectThrown(stripVTControlCharacters(run.output().slice(0, firstEnd)));
    // A content-only rebuild does not ask the host again, but its program
    // still lacks the host's files: said again.
    let since = run.output().length;
    touchIndex();
    expectThrown(await untilSummary(since));
    // `throw.ts` removed: the root list changed, the host is asked, answers.
    since = run.output().length;
    rmSync(thrower);
    expectClean(await untilSummary(since));
    since = run.output().length;
    touchIndex();
    expectClean(await untilSummary(since));
    // Back: the host throws on a rebuild, not only on the first build.
    since = run.output().length;
    writeFileSync(thrower, "export const thrown = true;\n");
    expectThrown(await untilSummary(since));
  } finally {
    await run.stop();
  }
}, 120_000);
