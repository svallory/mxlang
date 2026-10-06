import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";

/**
 * A diagnostic whose generated position has no source mapping is never
 * dropped (decision 161). A whole-file Solid unit maps its values but no tag,
 * so with no JSX types each element's TS7026 sits in generated text no
 * mapping covers: Volar used to discard them, and `mx-tsc` reported only the
 * mapped `missingName`.
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
  it("fails the run and reports each on the element that encloses it, as the author's", () => {
    const { status, lines } = mxTsc("unmapped-solid-failing");
    const element = (at: string) =>
      expect.stringMatching(
        new RegExp(
          `Page\\.mx\\(${at}\\): error TS7026: JSX element implicitly has type 'any' because no interface 'JSX\\.IntrinsicElements' exists\\. \\(position approximate: generated \\d+:\\d+\\)$`,
        ),
      );

    expect(status).not.toBe(0);
    // Opening and closing tag of `<div>` (3,1), `<span>` (4,3) and `<p>`
    // (5,3), each on its own element, never a sibling or line 1; the mapped
    // `missingName` keeps its exact position and message.
    expect(lines).toEqual([
      element("3,1"),
      element("3,1"),
      element("4,3"),
      element("4,3"),
      element("5,3"),
      element("5,3"),
      expect.stringMatching(
        /Page\.mx\(5,8\): error TS2304: Cannot find name 'missingName'\.$/,
      ),
    ]);
    expect(lines.join("\n")).not.toContain("not yours");
  }, 60_000);

  it("leaves an exactly mapped diagnostic's message and position as they were", () => {
    const { status, lines } = mxTsc("expression-values/html");

    expect(status).not.toBe(0);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("position approximate");
    expect(lines[0]).toMatch(/page\.mx\(3,37\): error TS2820: /);
  }, 60_000);
});
