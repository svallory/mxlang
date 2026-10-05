import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fixtures, mxTsc, run, SPAWN_TIMEOUT_MS } from "./test-support.ts";

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

// The Solid native-attribute guard's spread helper is unconstrained, so a
// spread of any type (unknown, string, number, boolean) type-checks. A
// `T extends object` bound reported TS2345 in generated code for these.
it(
  "type-checks unknown, string, number and boolean spreads on a native element",
  () => {
    const result = run(mxTsc, [
      "--noEmit",
      "-p",
      join(fixtures, "attr-guard-solid-passing"),
    ]);

    expect(result.output).toBe("");
    expect(result.status).toBe(0);
  },
  SPAWN_TIMEOUT_MS,
);
