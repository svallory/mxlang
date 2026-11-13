import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtures, mxTsc, run, SPAWN_TIMEOUT_MS } from "./test-support.ts";

// One `mx-tsc` run per fixture: the solid fixture feeds two tests, and its
// output is a pure function of the fixture.
const runs = new Map<string, ReturnType<typeof run>>();
function runFixture(fixture: string) {
  let result = runs.get(fixture);
  if (!result) {
    result = run(mxTsc, ["--noEmit", "-p", join(fixtures, fixture)]);
    runs.set(fixture, result);
  }
  return result;
}

describe("mx-tsc", () => {
  // Every spawn below blocks this worker's thread, and consecutive
  // synchronous tests never return to the event loop. Past a minute of that
  // vitest's own worker RPC times out (`Timeout calling "onTaskUpdate"`) and
  // fails a run whose tests all passed, so each test hands the loop back.
  afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

  it.each([
    ["html", "attr-tag-html-failing", "(3,9)", "(3,13)"],
    ["preact", "attr-tag-preact-failing", "(3,9)", "(3,13)"],
    ["solid", "attr-tag-solid-failing", "(3,29)", "(3,33)"],
  ])(
    "checks %s attribute-tag values against the callee Input",
    (_host, fixture, tagPosition, attributePosition) => {
      const result = runFixture(fixture);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain(
        `Missing${fixture.includes("solid") ? ".solid" : ""}.mx${tagPosition}`,
      );
      expect(result.output).toContain("Property 'title' is missing");
      expect(result.output).toContain(
        `Wrong${fixture.includes("solid") ? ".solid" : ""}.mx${attributePosition}`,
      );
      expect(result.output).toContain(
        "Type 'number' is not assignable to type 'string'",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  // A bad attribute-tag value is checked once, where the record helper takes
  // its argument; the enclosing call must not check the same value again
  // (once at the tag and once unmapped).
  it.each([
    ["html", "attr-tag-html-failing", "mx", "(3,13)", "(3,9)"],
    ["preact", "attr-tag-preact-failing", "mx", "(3,13)", "(3,9)"],
    ["solid", "attr-tag-solid-failing", "solid.mx", "(3,33)", "(3,29)"],
  ])(
    "reports one diagnostic per bad %s attribute-tag value, at its authored position",
    (_host, fixture, extension, attributePosition, tagPosition) => {
      const result = runFixture(fixture);
      const errors = (file: string) =>
        result.output
          .split("\n")
          .filter((line) => line.includes(`${fixture}/src/${file}(`))
          .map((line) => line.slice(line.indexOf("(")).split(":")[0]);

      expect(errors(`Wrong.${extension}`)).toEqual([attributePosition]);
      expect(errors(`Missing.${extension}`)).toEqual([tagPosition]);
    },
    SPAWN_TIMEOUT_MS,
  );

  // Every value shape (declared in `Shapes`), one bad occurrence per file:
  // exactly one diagnostic, at the authored attribute or tag. A repeated tag
  // folds its occurrences through a builder that takes the callee's declared
  // prop type, so the bad occurrence's error is on its own `id` attribute.
  const shapes = [
    ["Extra", "TS2353", ["(3,25)", "(3,45)"]],
    ["Nested", "TS2322", ["(3,31)", "(3,31)"]],
    ["NestedMissing", "TS2345", ["(3,11)", "(3,31)"]],
    ["Repeated", "TS2322", ["(3,16)", "(3,36)"]],
    ["Renderable", "TS2322", ["(3,11)", "(3,31)"]],
  ] as const;
  it.each(
    ["html", "preact", "solid"].flatMap((host, hostIndex) =>
      shapes.map(
        ([name, code, positions]) =>
          [host, name, code, positions[hostIndex === 2 ? 1 : 0]] as const,
      ),
    ),
  )(
    "reports one diagnostic for a bad %s attribute-tag shape: %s",
    (host, name, code, position) => {
      const extension = host === "solid" ? "solid.mx" : "mx";
      const result = runFixture(`attr-tag-${host}-shapes`);
      const lines = result.output
        .split("\n")
        .filter((line) => line.includes(`/src/${name}.${extension}(`));

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(
        `${name}.${extension}${position}: error ${code}`,
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  // A required prop given occurrences that are certain to be added (two
  // unconditional ones, or one in each branch of an `<if>`/`<else>`): the
  // builder is told `add` runs, so its record has no `undefined` and the call
  // checks clean.
  it.each(
    ["html", "preact", "solid"].flatMap((host) =>
      ["Required", "RequiredIf"].map((file) => [host, file] as const),
    ),
  )(
    "accepts a %s attribute tag certain to be given for a required prop: %s",
    (host, file) => {
      const extension = host === "solid" ? "solid.mx" : "mx";
      const result = runFixture(`attr-tag-${host}-shapes`);
      const lines = result.output
        .split("\n")
        .filter((line) => line.includes(`/src/${file}.${extension}(`));

      expect(lines).toEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    // `<Card><@tab title=1/></Card>`: the wrong attribute type is reported
    // on `title` (its own authored column), not on `tab` (the fallback
    // used only when there is no attribute of its own to blame) —
    // `solid-attr-tag-attr-offset`.
    "reports a solid attribute-tag's wrong value type on the attribute itself, not the tag name",
    () => {
      const result = runFixture("attr-tag-solid-failing");

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("Wrong.solid.mx(3,33): error TS2322");
      expect(result.output).toContain(
        "Type 'number' is not assignable to type 'string'",
      );
    },
    SPAWN_TIMEOUT_MS,
  );
});
