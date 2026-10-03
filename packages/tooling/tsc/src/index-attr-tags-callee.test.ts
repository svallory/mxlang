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
