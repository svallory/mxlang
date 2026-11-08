import { describe, expect, it } from "vitest";
import { ROWS, runRows } from "./test-affected-parity.ts";

describe("test:affected parity verifier rows", () => {
  it("every mutation row selects what native selects (the control row disagrees by design)", async () => {
    const results = await runRows();
    expect(results.map((r) => r.row.name)).toEqual(ROWS.map((r) => r.name));
    expect(
      results
        .filter((r) => r.problems.length > 0)
        .map((r) => `${r.row.name}: ${r.problems.join(" | ")}`),
    ).toEqual([]);
  }, 120_000);
});
