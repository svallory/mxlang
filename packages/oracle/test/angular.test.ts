import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isDerivedFrom, runAngularTable } from "../src/report-angular";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "..", "fixtures", "angular", "__golden__");

/**
 * Runs the same 59-fixture set `bun run oracle:angular` runs, through the
 * same `runAngularTable` function, so `bun run test` (and therefore
 * `bun run verify`) exercises it in CI rather than only the standalone
 * `oracle:angular` script a developer has to remember to run by hand.
 */
describe("oracle:angular fixtures", () => {
  // Compiles every fixture, parses each emitted template through
  // `@angular/compiler`, and now also `tsc`-es each emitted tag module. That
  // last pass is what moved the cost: measured at **31s** here, not the ~3s
  // this gate took when it only parsed templates. vitest's 5s default is a
  // machine-load timeout, not a budget for the work, and it reddened
  // `bun run verify` intermittently before this was set. 120s rather than the
  // 60s the parse-only gate used, since 60s is only ~2x the measured runtime
  // on exactly the loaded box that motivated the timeout in the first place.
  // Same reasoning as `src/custom-tags.test.ts`.
  it("every fixture passes", { timeout: 120_000 }, () => {
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

describe("isDerivedFrom (the mapping assertion's derivation list)", () => {
  it("checks the DOM event name, not only the source's shape", () => {
    // The derivation is real: `onClick` -> `click`, lowercased exactly as
    // written — no aliases (decision 101 (c)), so `dblclick` is NOT it.
    expect(isDerivedFrom("click", "onClick")).toBe(true);
    expect(isDerivedFrom("doubleclick", "onDoubleClick")).toBe(true);
    expect(isDerivedFrom("dblclick", "onDoubleClick")).toBe(false);
    // The hole this closes: any generated text used to pass beside an
    // `onX` source, so a misaligned event mapping could not fail.
    expect(isDerivedFrom("banana", "onClick")).toBe(false);
  });

  it("derives `on-<exact>` and a native element's lowercase `onclick`", () => {
    expect(isDerivedFrom("my-event", "on-my-event")).toBe(true);
    expect(isDerivedFrom("click", "onclick")).toBe(true);
    expect(isDerivedFrom("onclick", "onclick")).toBe(false);
  });

  it("scopes the containment hatch to a `by=` arrow's body", () => {
    // The one place a contained-but-not-equal run is real: `by=(p => p.id)`
    // tracks the arrow's body, sliced out of the source.
    expect(isDerivedFrom("p.id", "(p => p.id)")).toBe(true);
    expect(isDerivedFrom("p.id", "p => p.id")).toBe(true);
    // Anywhere else containment proves nothing: `name` appearing inside
    // `user.name` does not make one a derivation of the other.
    expect(isDerivedFrom("name", "user.name")).toBe(false);
    expect(isDerivedFrom("id", "(p => p.id)")).toBe(false);
  });
});
