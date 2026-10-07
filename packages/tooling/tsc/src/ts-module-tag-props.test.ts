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
  return { status: run.status, byFile };
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
    expect(result.status).not.toBe(0);
  }, 120_000);

  it("reports the same shapes for a .mx tag (control)", () => {
    expect(result.byFile.get("ControlWrong")).toEqual(["(3,10) TS2322"]);
    expect(result.byFile.get("ControlMissing")).toEqual(["(3,2) TS2345"]);
  }, 120_000);
});
