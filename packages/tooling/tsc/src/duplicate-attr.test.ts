import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { fixtures, mxTsc, runSplit, SPAWN_TIMEOUT_MS } from "./test-support.ts";

describe("mx-tsc duplicate attributes", () => {
  afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

  it(
    "warns at the repeated attribute, names the first, and exits 0",
    () => {
      const result = runSplit(mxTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "duplicate-attr"),
      ]);
      const stderr = stripVTControlCharacters(result.stderr);

      expect(result.status).toBe(0);
      // Line 4, column 3 (1-based) is the second `class`; the message names
      // the first at 3:5 in the compiler's own 1-based line, 0-based column.
      expect(stderr).toMatch(/Page\.mx\(4,3\): warning TS80002/);
      expect(stderr).toContain(
        "duplicate attribute `class`: also written at 3:5",
      );
      expect(stderr.match(/duplicate attribute/g)).toHaveLength(1);
    },
    SPAWN_TIMEOUT_MS,
  );
});
