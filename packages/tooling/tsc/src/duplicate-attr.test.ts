import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { fixtures, mxTsc, runSplit, SPAWN_TIMEOUT_MS } from "./test-support.ts";

describe("mx-tsc duplicate attributes", () => {
  afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

  it(
    "warns at the dropped attribute, names the survivor, and exits 0",
    () => {
      const result = runSplit(mxTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "duplicate-attr"),
      ]);
      const stderr = stripVTControlCharacters(result.stderr);

      expect(result.status).toBe(0);
      // Line 3, column 6 (1-based) is the first `class`, the dropped one
      // (decision 135); the message names the surviving second at 4:3,
      // 1-based like the position mx-tsc prints.
      expect(stderr).toMatch(/Page\.mx\(3,6\): warning TS80002/);
      expect(stderr).toContain(
        "duplicate attribute `class`: the later one at 4:3 wins, so this one is dropped",
      );
      expect(stderr.match(/duplicate attribute/g)).toHaveLength(1);
    },
    SPAWN_TIMEOUT_MS,
  );
});
