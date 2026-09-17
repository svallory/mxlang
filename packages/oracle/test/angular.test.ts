import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runAngularTable } from "../src/report-angular";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "..", "fixtures", "angular", "__golden__");

/**
 * Runs the same 59-fixture set `bun run oracle:angular` runs, through the
 * same `runAngularTable` function, so `bun run test` (and therefore
 * `bun run verify`) exercises it in CI rather than only the standalone
 * `oracle:angular` script a developer has to remember to run by hand.
 */
describe("oracle:angular fixtures", () => {
  // Compiles 67 fixtures and parses each emitted template through
  // `@angular/compiler`. It runs in ~3s alone, which leaves little room under
  // vitest's 5s default once the root suite runs in parallel on a loaded
  // machine — and that default is a machine-load timeout, not a budget for the
  // work. Same reasoning, and same value, as `src/custom-tags.test.ts`.
  it("every fixture passes", { timeout: 60_000 }, () => {
    const { rows, failed } = runAngularTable(false);
    const failures = rows.filter((r) => r.verdict === "fail");
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    expect(failed).toBe(false);
  });

  it("the AST golden's span-stripping keeps semantic fields like a template reference's name (round 2, R1)", () => {
    // A prior version of the runner's SPAN_KEY strip list explicitly
    // dropped `references` (a real semantic field — `<ng-template #Empty>`'s
    // reference variable name), so `define-no-params`'s golden was
    // identical whether the source read `#Empty`, `#TOTALLY_WRONG`, or no
    // reference at all. This reads the committed golden directly and
    // asserts the reference name survived stripping.
    const golden = readFileSync(
      join(goldenDir, "define-no-params.ast.json"),
      "utf8",
    );
    expect(golden).toContain("Empty");
    const parsed = JSON.parse(golden);
    expect(parsed[0]?.references?.[0]?.name).toBe("Empty");
  });
});
