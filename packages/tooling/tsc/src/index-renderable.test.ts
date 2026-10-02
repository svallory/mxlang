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
    ["solid", "renderable-solid-passing"],
    ["preact", "renderable-preact-passing"],
  ])(
    "accepts %s callers of a declared renderable attribute tag",
    (_host, fixture) => {
      const result = run(mxTsc, ["--noEmit", "-p", join(fixtures, fixture)]);

      expect(result.output).toBe("");
      expect(result.status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it.each([
    ["solid", "renderable-solid-failing", "Page.solid.mx(6,"],
    ["preact", "renderable-preact-failing", "Page.mx(3,36)"],
  ])(
    "rejects a %s caller that misuses a declared attribute-tag param",
    (_host, fixture, position) => {
      const result = run(mxTsc, ["--noEmit", "-p", join(fixtures, fixture)]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain(position);
      expect(result.output).toContain(
        "error TS2339: Property 'toUpperCase' does not exist on type 'number'.",
      );
      expect(result.output.match(/error TS/g)).toHaveLength(1);
    },
    SPAWN_TIMEOUT_MS,
  );
});
