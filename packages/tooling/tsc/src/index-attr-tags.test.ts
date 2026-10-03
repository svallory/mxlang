import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtures, mxTsc, run, SPAWN_TIMEOUT_MS } from "./test-support.ts";

// One `mx-tsc` run per fixture: the solid fixture feeds two tests, and its
// output is a pure function of the fixture.
const runs = new Map<string, ReturnType<typeof run>>();
function runFixture(fixture: string) {
  let result = runs.get(fixture);
  if (!result) {
    result = run(mxTsc, ["--noEmit", "-p", join(fixtures, fixture)]);
    runs.set(fixture, result);
  }
  return result;
}

describe("mx-tsc", () => {
  // Every spawn below blocks this worker's thread, and consecutive
  // synchronous tests never return to the event loop. Past a minute of that
  // vitest's own worker RPC times out (`Timeout calling "onTaskUpdate"`) and
  // fails a run whose tests all passed, so each test hands the loop back.
  afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

  it.each([
    ["html", "attr-tag-html-failing", "(3,9)"],
    ["preact", "attr-tag-preact-failing", "(3,9)"],
    ["solid", "attr-tag-solid-failing", "(3,29)"],
  ])(
    "checks %s attribute-tag values against the callee Input",
    (_host, fixture, tagPosition) => {
      const result = runFixture(fixture);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain(
        `Missing${fixture.includes("solid") ? ".solid" : ""}.mx${tagPosition}`,
      );
      expect(result.output).toContain("Property 'title' is missing");
      expect(result.output).toContain(
        `Wrong${fixture.includes("solid") ? ".solid" : ""}.mx${tagPosition}`,
      );
      expect(result.output).toContain(
        "Type 'number' is not assignable to type 'string'",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    // `<Card><@tab title=1/></Card>`: the wrong attribute type is reported
    // on `title` (its own authored column), not on `tab` (the fallback
    // used only when there is no attribute of its own to blame) —
    // `solid-attr-tag-attr-offset`.
    "reports a solid attribute-tag's wrong value type on the attribute itself, not the tag name",
    () => {
      const result = runFixture("attr-tag-solid-failing");

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("Wrong.solid.mx(3,33): error TS2322");
      expect(result.output).toContain(
        "Type 'number' is not assignable to type 'string'",
      );
    },
    SPAWN_TIMEOUT_MS,
  );
});
