import { describe, expect, it } from "vitest";
import { expectedSelection, ROWS, runRows } from "./test-affected-parity.ts";

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

describe("expectedSelection (the sampled-edit model of native)", () => {
  const deps = new Map([
    ["p a.test.ts", ["/r/lib.ts"]],
    ["p b.test.ts", ["/r/other.ts"]],
  ]);

  it("selects the tests that import the file, and the file's own test", () => {
    expect(expectedSelection(deps, "/r/lib.ts", false, "lib.ts")).toEqual([
      "p a.test.ts",
    ]);
    expect(expectedSelection(deps, "/r/b.test.ts", false, "b.test.ts")).toEqual(
      ["p b.test.ts"],
    );
  });

  it("selects every test for a force-rerun trigger", () => {
    expect(
      expectedSelection(deps, "/r/package.json", true, "package.json"),
    ).toEqual(["p a.test.ts", "p b.test.ts"]);
  });
});
