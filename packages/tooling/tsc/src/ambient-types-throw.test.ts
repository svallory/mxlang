import { existsSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupProjects,
  fakeProject,
  specifier,
} from "../../../../test-fixtures/third-party-targets/support.ts";
import { runInProcess } from "./in-process.ts";

/**
 * A host whose `ambientTypes` throws (the `ambient-types-throws` fake) must
 * not crash `mx-tsc`: one file-level error names its package and quotes the
 * message, and the run goes on without that host's ambient files.
 */
const DIAGNOSTIC =
  "error TS80004: host @fake/mx-ambient-types-throws: ambientTypes threw: cannot find astro install";

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    module: "esnext",
    target: "es2022",
    outDir: "out",
  },
  include: ["index.ts"],
});

afterEach(cleanupProjects);

function throwingProject(files: Record<string, string>) {
  return fakeProject({
    mx: { target: specifier("ambient-types-throws") },
    install: ["ambient-types-throws"],
    files: { "tsconfig.json": TSCONFIG, ...files },
  });
}

describe("mx-tsc with a host whose ambientTypes throws", () => {
  it("reports one file-level error naming the package, and still emits a trivial file", () => {
    const project = throwingProject({
      "index.ts": "export const answer: number = 42;\n",
    });

    const run = runInProcess(["-p", "tsconfig.json"], project.root);
    const output = stripVTControlCharacters(`${run.stdout}${run.stderr}`);

    expect(run.status).toBe(1);
    expect(output).toContain(DIAGNOSTIC);
    expect(
      output.split("\n").filter((line) => line.includes("TS80004")),
    ).toEqual([DIAGNOSTIC]);
    expect(existsSync(join(project.root, "out", "index.js"))).toBe(true);
  });

  it("keeps type-checking: a real error in the same project is still reported", () => {
    const project = throwingProject({
      "index.ts": "export const answer: number = 'forty-two';\n",
    });

    const run = runInProcess(["-p", "tsconfig.json"], project.root);
    const output = stripVTControlCharacters(`${run.stdout}${run.stderr}`);

    expect(run.status).toBe(1);
    expect(output).toContain(DIAGNOSTIC);
    expect(output).toMatch(/index\.ts\(1,\d+\): error TS2322/);
  });
});
