import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";

/**
 * A diagnostic whose generated position has no source mapping is never
 * dropped (decision 161). A whole-file Solid unit maps no expression values, so
 * `missingName` and `1 * "a"` sit in generated text no mapping covers: Volar
 * used to discard both, and `mx-tsc` exited 0 on a page full of errors.
 */

const fixtures = join(import.meta.dirname, "fixtures");

function mxTsc(project: string) {
  const dir = join(fixtures, project);
  const run = runInProcess(
    ["--noEmit", "--pretty", "false", "-p", join(dir, "tsconfig.json")],
    dir,
  );
  return {
    status: run.status,
    lines: `${run.stdout}\n${run.stderr}`
      .split("\n")
      .filter((line) => line.includes(".mx")),
  };
}

describe("mx-tsc and a diagnostic with no source mapping", () => {
  it("fails the run and reports it on the tag that encloses it, not on a sibling or line 1", () => {
    const { status, lines } = mxTsc("unmapped-solid-failing");

    expect(status).not.toBe(0);
    // Page.mx maps only `export interface Input { }` (line 1) and no value:
    // `missingName` is spelled inside `<p>` (line 5, column 3), the construct
    // that holds it. The kind of suffix depends on mapping that value
    // (#362), so only its presence is pinned here.
    expect(lines).toEqual([
      expect.stringMatching(
        /Page\.mx\(5,3\): error TS2304: Cannot find name 'missingName'\. \((position approximate|in MX-generated code, not yours: an MX bug); generated \d+:\d+\)$/,
      ),
    ]);
  }, 60_000);

  it("leaves an exactly mapped diagnostic's message and position as they were", () => {
    const { status, lines } = mxTsc("expression-values/html");

    expect(status).not.toBe(0);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("position approximate");
    expect(lines[0]).toMatch(/page\.mx\(3,37\): error TS2820: /);
  }, 60_000);
});
