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

// A spread whose object type is wrong still reports, at the authored attribute
// (line 5 of the page), not in the generated guard call; the `unknown` spread
// on line 4 is clean.
it(
  "still reports an object spread with a wrongly typed key at the authored attribute",
  () => {
    const result = run(mxTsc, [
      "--noEmit",
      "-p",
      join(fixtures, "attr-guard-solid-failing"),
    ]);

    const lines = result.output
      .split("\n")
      .filter((line) => line.includes("error TS"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Page\.solid\.mx\(5,\d+\): error TS2322/);
    expect(result.status).not.toBe(0);
  },
  SPAWN_TIMEOUT_MS,
);
