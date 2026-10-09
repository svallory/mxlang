import { spawn } from "node:child_process";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupProjects,
  fakeProject,
  specifier,
} from "../../../../test-fixtures/third-party-targets/support.ts";
import { reportWatchPass } from "./index.ts";
import { mxTsc } from "./test-support.ts";

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
  const child = spawn(
    process.execPath,
    [mxTsc, "-w", "-p", "tsconfig.json", "--preserveWatchOutput"],
    {
      cwd: project.root,
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
  const lifetime = setTimeout(() => child.kill("SIGKILL"), 110_000);
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
  // One build's output, up to its summary. The first summary can precede the
  // watchers being armed, so a touch is retried until a rebuild starts.
  const untilSummary = async (since: number, touch?: () => void) => {
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
        throw new Error(`watch did not finish a build:\n${output}`);
      }
      if (
        touch &&
        Date.now() >= nextTouch &&
        !output.slice(since).includes("File change detected")
      ) {
        touch();
        nextTouch = Date.now() + 2_500;
      }
      await delay(100);
    }
    return stripVTControlCharacters(output.slice(since));
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
    // The first build holds `throw.ts`.
    expectThrown(await untilSummary(0));
    // A content-only rebuild does not ask the host again, but its program
    // still lacks the host's files: said again.
    let since = output.length;
    touchIndex();
    expectThrown(await untilSummary(since, touchIndex));
    // `throw.ts` removed: the root list changed, the host is asked, answers.
    since = output.length;
    rmSync(thrower);
    expectClean(await untilSummary(since));
    since = output.length;
    touchIndex();
    expectClean(await untilSummary(since, touchIndex));
    // Back: the host throws on a rebuild, not only on the first build.
    since = output.length;
    writeFileSync(thrower, "export const thrown = true;\n");
    expectThrown(await untilSummary(since));
  } finally {
    clearTimeout(lifetime);
    child.kill("SIGKILL");
    await closed;
  }
}, 120_000);
