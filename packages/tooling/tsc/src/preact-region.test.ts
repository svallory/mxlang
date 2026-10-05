/**
 * `mx-tsc` over `.preact.mx` region files (decision 154): a type error inside
 * a region is reported at its authored `.preact.mx` line and column, both in
 * a region expression and in an attribute-tag body whose param type comes
 * from a `.preact.mx` callee's `Input` (read by the shared JSX callee
 * reader). The passing twin is the same project with both errors fixed.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtures, mxTsc, run, SPAWN_TIMEOUT_MS } from "./test-support.ts";

describe("mx-tsc on .preact.mx", () => {
  // Each spawn blocks this worker; hand the event loop back between tests.
  afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

  it(
    "reports region type errors at the authored position",
    () => {
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "preact-region-failing"),
      ]);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(
        "Page.preact.mx(10,27): error TS2339: Property 'toUpperCase' does not exist on type 'number'.",
      );
      expect(result.output).toContain(
        "Page.preact.mx(13,22): error TS2339: Property 'trim' does not exist on type 'number'.",
      );
      expect(result.output.match(/error TS/g)).toHaveLength(2);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "accepts the same project with the errors fixed",
    () => {
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "preact-region-passing"),
      ]);
      expect(result.output).toBe("");
      expect(result.status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );
});
