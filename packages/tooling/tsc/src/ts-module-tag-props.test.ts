import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";

/**
 * Decision 116 routes a tag imported from a `.ts` module (a value import, not
 * a `.mx` default import) through the dynamic call. Its props used to be typed
 * `Record<string, any>`, so a wrong or missing prop compiled silently while the
 * same call to a `.mx` tag reported. The fixture calls one `.ts` tag and one
 * `.mx` control the same four ways; each line is `<Tag ...>` at column 1.
 */

const dir = join(import.meta.dirname, "fixtures", "ts-module-tag-props-html");

function errorsByFile() {
  const run = runInProcess(
    ["--noEmit", "--pretty", "false", "-p", join(dir, "tsconfig.json")],
    dir,
  );
  const byFile = new Map<string, string[]>();
  for (const line of `${run.stdout}\n${run.stderr}`.split("\n")) {
    const match = /src\/(\w+)\.mx(\(\d+,\d+\)): error (TS\d+)/.exec(line);
    if (match) {
      const list = byFile.get(match[1] as string) ?? [];
      list.push(`${match[2]} ${match[3]}`);
      byFile.set(match[1] as string, list);
    }
  }
  return { byFile };
}

describe("mx-tsc on a tag imported from a .ts module", () => {
  const result = errorsByFile();

  it("reports a wrong-typed prop on the authored attribute value", () => {
    expect(result.byFile.get("Wrong")).toEqual(["(3,7) TS2322"]);
  }, 120_000);

  it("reports a missing required prop on the tag name", () => {
    expect(result.byFile.get("Missing")).toEqual(["(3,2) TS2345"]);
  }, 120_000);

  it("reports an unknown prop on the authored attribute", () => {
    expect(result.byFile.get("Extra")).toEqual(["(3,17) TS2353"]);
  }, 120_000);

  it("reports nothing for a correct call", () => {
    expect(result.byFile.has("Good")).toBe(false);
  }, 120_000);

  it("reports the same shapes for a .mx tag (control)", () => {
    expect(result.byFile.get("ControlWrong")).toEqual(["(3,10) TS2322"]);
    expect(result.byFile.get("ControlMissing")).toEqual(["(3,2) TS2345"]);
  }, 120_000);

  // Concise syntax has no `<`: the name starts at the span's first character.
  it("maps a concise-mode call onto the written name", () => {
    expect(result.byFile.get("ConciseMissing")).toEqual(["(4,3) TS2345"]);
    expect(result.byFile.get("ConciseWrong")).toEqual(["(4,8) TS2322"]);
  }, 120_000);

  it("checks an authored dynamic tag the same way", () => {
    expect(result.byFile.get("AuthoredMissing")).toEqual(["(3,1) TS2345"]);
    expect(result.byFile.get("AuthoredWrong")).toEqual(["(3,10) TS2322"]);
  }, 120_000);

  // Body content is passed as `content`; the callee's input must declare it.
  it("reports body content the callee's input does not declare", () => {
    expect(result.byFile.get("Body")).toEqual(["(3,1) TS2353"]);
    expect(result.byFile.get("AuthoredBody")).toEqual(["(3,1) TS2353"]);
  }, 120_000);

  it("stays silent for an overloaded callee, whichever signature matches", () => {
    expect(result.byFile.has("OverFirst")).toBe(false);
    expect(result.byFile.has("OverLast")).toBe(false);
  }, 120_000);

  it("stays silent when only the last two of three overloads share an input", () => {
    expect(result.byFile.has("Tri")).toBe(false);
  }, 120_000);

  // A constrained generic erases to its constraint, and the props object is
  // fresh, so an extra attribute is reported even though the direct call
  // `g({ a: "x", b: 1 })` is accepted. Known limit, documented in the spec.
  it("reports an extra attribute on a constrained-generic callee (known limit)", () => {
    expect(result.byFile.get("ConGoodExtra")).toEqual(["(3,10) TS2353"]);
  }, 120_000);

  it("leaves a call with tag arguments unchecked", () => {
    expect(result.byFile.has("Args")).toBe(false);
  }, 120_000);

  it("stays silent for a zero-parameter callee", () => {
    expect(result.byFile.has("Zero")).toBe(false);
  }, 120_000);

  it("checks an optional (`| undefined`) callee", () => {
    expect(result.byFile.get("Maybe")).toEqual(["(3,8) TS2322"]);
  }, 120_000);
});
