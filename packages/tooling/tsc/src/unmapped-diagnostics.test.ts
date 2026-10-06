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
  it("fails the run and reports each one at the nearest mapped span", () => {
    const { status, lines } = mxTsc("unmapped-solid-failing");

    expect(status).not.toBe(0);
    // Page.mx maps only `export interface Input { }` (line 1): both errors
    // land there, and each names where TypeScript really found it.
    expect(lines).toEqual([
      expect.stringMatching(
        /Page\.mx\(1,1\): error TS2304: Cannot find name 'missingName'\. \(position approximate: generated \d+:\d+\)$/,
      ),
      expect.stringMatching(
        /Page\.mx\(1,1\): error TS2363: .* \(position approximate: generated \d+:\d+\)$/,
      ),
    ]);
  }, 60_000);

  it("says it is MX's bug when the generated code holds nothing the author wrote", () => {
    // `Page.mx` is `<p>hi</p>`; the fixture's tsconfig points `@mxlang/html`
    // nowhere, so the unresolved import MX generates is the error. No authored
    // code is on its line: it is MX's own scaffolding, at the file start.
    const { status, lines } = mxTsc("unmapped-scaffolding-failing");

    expect(status).not.toBe(0);
    expect(lines).toEqual([
      expect.stringMatching(
        /Page\.mx\(1,1\): error TS2307: Cannot find module '@mxlang\/html'.* \(in MX-generated code, not yours: an MX bug; generated 1:\d+\)$/,
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
