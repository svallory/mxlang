import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtures, mxTsc, run, SPAWN_TIMEOUT_MS } from "./test-support.ts";

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
      const result = run(mxTsc, ["--noEmit", "-p", join(fixtures, fixture)]);

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
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "attr-tag-solid-failing"),
      ]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("Wrong.solid.mx(3,33): error TS2322");
      expect(result.output).toContain(
        "Type 'number' is not assignable to type 'string'",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it.each([
    ["html", "callee-diagnostic-html-failing", "Card.mx(2,14)", "Page.mx"],
    // The `Input` interface line above `broken` gains three characters when
    // printed; the exact column proves the diagnostic is placed against the
    // authored source, not the printed text (solid-mx-tsc-column-against-printed-text).
    [
      "solid",
      "callee-diagnostic-solid-failing",
      "Card.solid.mx(4,14)",
      "Page.solid.mx",
    ],
  ])(
    "reports a %s callee's own type error in the callee, not in the caller that read its Input",
    (_host, fixture, calleePosition, caller) => {
      const result = run(mxTsc, ["--noEmit", "-p", join(fixtures, fixture)]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain(`${calleePosition}: error TS2322`);
      expect(result.output).toContain(
        "Type 'string' is not assignable to type 'number'",
      );
      expect(result.output).not.toContain(`${caller}(`);
    },
    SPAWN_TIMEOUT_MS,
  );
});
